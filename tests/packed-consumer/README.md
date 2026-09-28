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
the tarball here (`file:./edytor.tgz`), runs `smoke.js` under node, runs the
Svelte consumer (`smoke-svelte.mjs`), and typechecks both postures (below).

## Worker consumer (`smoke-worker.mjs` + `worker.js`)

`worker.js` is a minimal room Durable Object importing ONLY `edytor/crdt` +
`edytor/crdt/edytor` (a compact copy of the `tests/do/room.ts` fixture).
`smoke-worker.mjs` bundles it with esbuild for a Worker target, asserts the
bundle holds the CRDT dist and no Svelte/DOM view module, then runs it in
Miniflare (SQLite storage, no port): `/health`, a writer pushes a seeded
document over a WebSocket upgrade, a second socket syncs it back, and a
frame without this generation's word is refused (1008). esbuild and
Miniflare come from the repo's `@cloudflare/vitest-plugin` devDependency.

## Svelte consumer (`smoke-svelte.mjs` + `svelte-app/`)

A real Vite/Svelte consumer of the tarball — `svelte-app/` imports `edytor`
(the component surface) and compiles the shipped `.svelte` sources through
the consumer's own `vite-plugin-svelte`, the documented bundler boundary:

- **`vite build` (client)** — the app bundle compiles `edytor/dist`'s
  `.svelte` components + plugin modules through the consumer's vite config
  (`svelte-app/vite.config.mjs`, `resolve.dedupe: ['svelte']`).
- **`vite build --ssr` + `render()`** — the supported SSR check: a
  `readonly` `<Edytor>` server-renders to markup (`data-edytor` markup,
  seeded text, `contenteditable="false"`). Plain node importing `.svelte`
  stays an expected failure — the SSR check goes through the Svelte build
  path instead (`ssr.noExternal: ['edytor']` so the bundle compiles it).
- **Browser mount** — `vite preview` serves the built app; the repo's
  playwright drives a real browser: editable + readonly editors mount,
  seeded paragraphs/marks render through `richTextPlugin`, a real
  click+type edit reaches the model, `facade.insertText` edits reach the
  model, and svelte `unmount()` tears the tree down (zero `[data-edytor]`
  nodes left). Requires the playwright browsers used by the editor-dom
  lanes; a missing binary reports `SKIP` explicitly — never claimed green.
- **Shared document** — the app also mounts TWO `<Edytor {document}>`
  views on one `createDocument()` result plus a real
  `document.attachSync(createIndexeddbSync(room))` provider (fresh room
  per run, real IndexedDB): both views share `facade`/`awareness`/
  `history` by identity, a click+type edit in view A converges into view
  B's DOM, a `facade.insertText` lands in both, `document.history.undo()`
  reverts across both, `encode()` → `loadDocument()` round-trips JSON as
  `hydrated`, and the document stays alive after unmount until
  `document.destroy()`.

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
- **The integrated document API** (the headline surface — no `bindCrdt`
  call, no engine injection): `createDocument({value, actor})` arrives
  `ready`/`local` with the actor published into awareness → `transact` +
  `facade.insertText` → `history.undo()`/`redo()` → `attribution` reads
  (`actorOf`, `actors`) → `encode()` → `loadDocument` restores identical
  JSON as `hydrated` on a fresh replica identity → `attachDocument` on a
  caller-owned doc attaches `pending`, seeds via `sync()`, and
  `destroy()` never destroys the borrowed doc → `attachSync` runs a sync
  factory against `{doc, awareness, synced}` and `document.destroy()`
  runs the tracked cleanup.
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
  with no `.svelte` leakage and no extensionless `import()` paths —
  including the whole document API (`createDocument`/`loadDocument`/
  `attachDocument`, `EdytorDocument`, `DocumentAttribution`, `JSONDoc`,
  `attachSync`) with zero casts.
- `tsconfig.bundler.json` — `moduleResolution: bundler`, same strictness,
  over `smoke-types.ts`: the full consumer surface — `import 'edytor'`
  (component, plugins, `createIndexeddbSync`, bound provider classes,
  the root-level document API + canonical JSON types), `edytor/crdt`,
  `edytor/crdt/edytor`.
- The vendored dts tree (`dist/crdt/vendor/yjs/dts`) resolves and
  references `lib0-v14` types — a real `dependencies` entry that arrives
  transitively; the consumer installs nothing extra.

## Notes

- `edytor.tgz`, `node_modules/`, lockfiles here are generated; do not
  commit them (see .gitignore).
- node >= 22 required (upstream `engines` — recorded in edytor package.json).

## Known upstream quirk

`esrap>=2.3.10` (a transitive dep via svelte) declares
`@typescript-eslint/types` as a peer dependency that nothing installs.
svelte's ambient `/// <reference types="esrap" />` then fails this
harness's `skipLibCheck: false` typecheck. The consumer's devDeps satisfy
the peer directly until upstream fixes it — this is why
`@typescript-eslint/types` appears in `package.json`.
