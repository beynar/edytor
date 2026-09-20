# packed-consumer — `edytor` package boundary proof

Durable harness for PK01 (plan §8): prove a fresh consumer can install the
packed `edytor` tarball and use the vendored Yjs v14 engine + the bound CRDT
layer — at runtime **and** at type level — without ever touching a private
or vendored path, and without pulling a second (v13) engine.

## Run

```sh
tests/packed-consumer/run.sh
```

The script packs the real package (`pnpm package` + `pnpm pack`), installs
the tarball here (`file:./edytor.tgz`), runs `smoke.js` under node, and
typechecks both postures (below).

## Package surface under test

| subpath              | content                                                     |
| -------------------- | ----------------------------------------------------------- |
| `edytor`             | editor components, plugins, CRDT bindings, sync factories   |
| `edytor/crdt`        | the raw vendored `@y/y@14.0.0-rc.26` engine module          |
| `edytor/crdt/edytor` | the engine-injected bindings (facade, providers, migration) |

`import 'edytor'` is the **component** surface: `dist/index.js` statically
reaches `./components/Edytor.svelte`, so it requires a bundler that
understands Svelte (the standard svelte-package shape). Plain node/SSR
consumers use `edytor/crdt` + `edytor/crdt/edytor` — the identical bindings
surface with no component in the graph. `smoke.js` asserts this boundary
explicitly (root rejects with `ERR_UNKNOWN_FILE_EXTENSION` under node).

## What it proves (smoke.js, runtime)

- `dist/crdt/vendor/yjs/src/index.js` ships and loads — Doc, unified
  `Y.Node`, maintained delta, update round-trip, relative positions,
  `UndoManager`.
- `edytor/crdt/edytor` assembles via `bindCrdt(Y)`: `createDoc`, `Awareness`,
  the `EdytorDoc` facade, providers, migration, sync protocol.
- The real consumer story: Doc + Awareness via public exports →
  `crdt.doc.create` → `init` → `insertBlock`/`insertText`/`formatRange` →
  two docs converge via state-vector update exchange in both directions →
  `dispose`/`destroy` teardown (doc destroy cascades to awareness).
- The registry-scoped undo seam (`ed.createUndoManager`) works.
- **Encapsulation**: `edytor/crdt/vendor/…`, `edytor/dist/…`, and
  `edytor/package.json` all reject with `ERR_PACKAGE_PATH_NOT_EXPORTED` —
  consumers cannot take private paths even accidentally.
- **One engine**: the packed `package.json` declares no
  `yjs`/`y-protocols`/`y-indexeddb`/`y-websocket`/`lib0` (only the
  `lib0-v14` alias), and a recursive scan of the installed tree finds no
  v13 artifact (pnpm `.pnpm` store + npm nested layouts both covered).

## What it proves (tsc, two postures)

- `tsconfig.json` — `moduleResolution: nodenext`, `strict`,
  `skipLibCheck: false`, `types: []` over `smoke-types.node.ts`: the
  node-safe surface (`edytor/crdt`, `edytor/crdt/edytor`) is fully typed
  with no `.svelte` leakage and no extensionless `import()` paths.
- `tsconfig.bundler.json` — `moduleResolution: bundler`, same strictness,
  over `smoke-types.ts`: the full consumer surface — `import 'edytor'`
  (component, plugins, `createIndexeddbSync`, bound provider classes),
  `edytor/crdt`, `edytor/crdt/edytor`.
- The vendored dts tree (`dist/crdt/vendor/yjs/dts`) resolves and
  references `lib0-v14` types — a real `dependencies` entry that arrives
  transitively; the consumer installs nothing extra.

## Notes

- `edytor.tgz`, `node_modules/`, lockfiles here are generated; do not
  commit them (see .gitignore).
- node >= 22 required (upstream `engines` — recorded in edytor package.json).
