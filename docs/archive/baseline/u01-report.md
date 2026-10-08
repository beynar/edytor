# U01 — Vendored Yjs v14 core + package boundary report

Date: 2026-09-19. Unit: **U01 — Vendor the core and prove the package boundary**.
Baseline: `yjs@13.6.30` + `lib0@0.2.117` still drive the live editor (untouched).

## 1. Vendored tree

```text
src/lib/crdt/vendor/yjs/
    src/          upstream src/ verbatim (34 files incl. subdirs) + patch P1
    global.d.ts   upstream verbatim + patch P1
    dts/          generated TS declarations (33 files; build artifact of U01, not upstream source)
    LICENSE       MIT © Kevin Jahns, verbatim
    UPSTREAM.md   provenance, checksums, pins, patch list, diff commands
    API-NOTES.md  v13→v14 API map + measured caveats
vendor-tests/yjs/
    tests/        upstream tests/ verbatim + patch P2 (17 files incl. index.js for fidelity)
    tests/sync-shim.js   P3: @y/protocols/sync ported onto the vendored engine
    upstream.test.js     vitest adapter (replaces lib0 runTests runner)
```

Verification: reversing P1 (`sed 's|lib0-v14|lib0|g'`) makes `src/` and
`global.d.ts` **byte-identical** to upstream `96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64`.
Tarball `yjs/archive/96c96e1…tar.gz` sha256 =
`4b5ad4100dcbd211fa33b420c0a992564e84286b654259a67e64c05af08d7b85`.
LICENSE is unmodified. 110 `lib0/` → `lib0-v14/` rewrites (P1), 0 bare `'lib0'`
specifiers, 0 leftovers.

**Upstream recheck (2026-09-19):** pinned commit is still upstream `main` HEAD;
`@y/y@14.0.0-rc.26` (2026-09-07) is still the newest published release. **No
drift since pinning** — baseline unchanged.

## 2. lib0 isolation (P1/P2/P3)

- Root keeps `lib0@^0.2.117` (v13 runtime + providers untouched).
- `lib0-v14 → npm:lib0@1.0.0-rc.32` is a real `dependencies` entry (satisfies
  upstream `^1.0.0-rc.29`); vendored code references `lib0-v14/*` literally —
  **no Vite/test alias anywhere** (neither shipping nor dev).
- `vendor-tests/yjs/tests/sync-shim.js` (P3) ports `@y/protocols@1.0.6-rc.1`
  `sync.js` onto the vendored engine — the npm `@y/protocols` would create a
  second `@y/y` engine copy and break `instanceof` checks.
- `@y/protocols@1.0.6-rc.1` kept as devDep (U07 porting reference; `@y/y` peer
  override-pinned to `14.0.0-rc.26`).

## 3. Smoke probes (`src/tests/crdt/v14-smoke.test.ts`, 13 tests — all green)

Asserted real behavior, exercising the actual rc.26 surface (see
`API-NOTES.md` for the full map): `Doc` + `doc.get(key)` → unified `Y.Node`
(memoized; root `name === null`); `setAttr/getAttr/hasAttr/deleteAttr/attrKeys`;
`insert`/`get`/`slice`/`length`/`toArray`; `format` + insert-with-format;
maintained **`node.delta`** (`{type:'delta', name, children:[{insert,format}…]}`);
`observe` YEvent (`target`, `delta`, `keysChanged`, `childListChanged`);
`observeDeep` single deep event with `deltaDeep` nested modifies; RDT `'delta'`
channel with transaction origin; relative positions (JSON + binary
round-trips, shift on earlier insert); update encode/apply both directions +
state vectors; `UndoManager` scoped undo/redo preserving remote contributions.

**Names that differ from v13 (measured, not guessed):**

- `Y.Map/Y.Array/Y.Text/Y.Xml*` — **all removed**; one `Y.Node`.
- `node.toString()` → element renderer `<name attrs>children</name>` (not raw text).
- `node.slice()` → Array of items (chars), not a string.
- `node.toJSON()` → `{name?, attrs?, children?}` tree.
- `node.delta` = lib0 RDT delta cache — **detached-node reads warn "Invalid
  access" and render empty; a detached `.delta` read poisons the cache across
  integration** — read `.delta` only once integrated (quirk recorded).
- `observeDeep` ≠ v13 event array — one `YEvent` per changed ancestor root,
  nested `deltaDeep`.
- `UndoManager` accepts `Doc | YNode | YNode[]` scope.
- New v14-only surface used later: `IdSet`/`IdMap`, renderers
  (`AttributionsRenderer`, `DiffRenderer`, `SnapshotRenderer`), `diffDocsToDelta`,
  `position-helpers` (delta↔relative positions), schemas (`$node`, `$doc`, …),
  V2 update encoders + `convertUpdateFormatV1ToV2`.

## 4. Upstream test record (authoritative, nothing skipped/hidden)

Vendored `tests/` run under vitest via `vendor-tests/yjs/upstream.test.js`
(each `testXxx(tc)` export → vitest test, real `lib0-v14/testing` `TestCase`):

| Command                                     | Result                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm test:crdt` (standard tier)            | **325 pass / 6 skip / 0 fail**, ~11 s                                  |
| `pnpm test:crdt:extensive` (`PRODUCTION=1`) | **331 pass / 0 skip / 0 fail**, ~200 s (incl. 30 000-op random stress) |

- The 6 standard-tier skips are upstream's own `t.skip(!t.production)` gates
  (y-array ×3, y-map ×3 extensive random tests) — identical to upstream's
  default `npm test` (`NODE_ENV=development`) behavior.
- `pnpm test:crdt` lane also runs `src/tests/crdt/**` (v14-smoke + legacy-v13):
  total **349 pass / 6 skip / 0 fail** across 3 files.
- `t.skip` maps to `ctx.skip()`; reproduction: `YJS_TEST_SEED=<n> pnpm test:crdt`.
- Vitest does not replicate upstream's `--repetition-time` repeat loop for
  `testRepeat*` (each runs once) — recorded in UPSTREAM.md.
- `pnpm test` (default glob `src/**/*.{test,spec}.*`) does not pick up
  `vendor-tests/` — the app gate stays clean and fast.

## 5. Package boundary proof

- `package.json#exports["./crdt"]` → `types: ./dist/crdt/vendor/yjs/dts/index.d.ts`,
  `default: ./dist/crdt/vendor/yjs/src/index.js`. `engines: node >=22.0.0`
  recorded (upstream requirement).
- `pnpm package` → svelte-package copies vendored JS + LICENSE + global.d.ts +
  `dts/` verbatim into `dist/crdt/vendor/yjs/`; publint **"All good!"**
- Declarations: svelte-package emits **no** d.ts for vendored JS — resolved by
  generating them upstream-style (`scripts/regen-crdt-vendor-types.sh` =
  `tsc -p tsconfig.vendor-dts.json` emitDeclarationOnly + two scripted fixups:
  `dts/global.d.ts` path-remap, `/// <reference>` in `dts/index.d.ts`). Emitted
  tree references `lib0-v14/*` types (real dep → resolves transitively).
  Chosen over a hand-written d.ts because it covers the full ~100-export
  surface with zero drift; regeneration command recorded in UPSTREAM.md.
- `tests/packed-consumer/` (durable harness): `run.sh` packs `edytor-0.0.11.tgz`,
  installs into a fresh dir, `node smoke.js` → **runtime PASS**; `tsc -p
tsconfig.json` (`nodenext`, **`skipLibCheck: false`**) → **types PASS**.
  `import * as Y from 'edytor/crdt'` works; `lib0-v14` arrives transitively.
- Tarball contents: 67 `crdt/` files (src impl + dts + LICENSE + global.d.ts).
  `UPSTREAM.md`/`API-NOTES.md` are **not** shipped (svelte-package filters .md)
  — repo-side manifest only; LICENSE ships = attribution preserved.
- `edytor/package.json` subpath is not exported (pre-existing; unchanged).

## 6. Provider compatibility gap — recorded for U07

| Package (current)      | Peer/dep pins                                                  | v14 status                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `y-protocols@1.0.7`    | peer `yjs ^13.0.0`, dep `lib0 ^0.2.85`                         | incompatible; v14 line = `@y/protocols@1.0.6-rc.1` (peer `@y/y:*`, dep `lib0 ^1.0.0-rc.1`) — but its modules `import '@y/y'` → **second engine copy**; `sync.js` actively uses Y (ported as P3 shim for tests); `awareness.js` uses `Y` only in JSDoc — works with vendored Doc at runtime but eagerly triggers the `__ $YJS14$ __` double-import warning + dead engine weight. U07: port or wrap, don't ship the npm copy against vendored docs. |
| `y-websocket@3.0.0`    | peer `yjs ^13.5.6`, deps `lib0 ^0.2.102`, `y-protocols ^1.0.5` | incompatible; `@y/websocket@4.0.0-0` exists for v14 (early rc — evaluate/port in U07)                                                                                                                                                                                                                                                                                                                                                             |
| `y-indexeddb@9.0.12`   | peer `yjs ^13.0.0`                                             | incompatible and **unused** — `src/lib/localProvider.ts` is a forked impl on `lib0 0.2.x` + `y-protocols 1.0.7`; needs port to `lib0-v14` + vendored engine (`@y/indexeddb` does not exist on npm)                                                                                                                                                                                                                                                |
| npm `@y/y` vs vendored | —                                                              | different engine instances; `instanceof`/constructor checks cross-fail; nothing may `import '@y/y'` against vendored docs (the `__ $YJS14$ __` guard logs an error)                                                                                                                                                                                                                                                                               |

## 7. Validation results (app gates all green)

| Command                                      | Result                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                                 | PASS (0 errors; `src/lib/crdt/vendor/**` excluded from app tsconfig — vendored JS not held to `checkJs`)                                         |
| `pnpm lint`                                  | PASS (prettier + eslint clean; vendor dirs ignored — even fixes the 2 pre-existing doc failures seen at U00, they were already resolved in tree) |
| `pnpm test -- --run`                         | PASS 328/328 (315 baseline + 13 smoke; vendor-tests not in glob)                                                                                 |
| `pnpm test:dom`                              | PASS 111/111                                                                                                                                     |
| `pnpm test:typecheck` / `test:dom:typecheck` | PASS 0 errors each                                                                                                                               |
| `pnpm test:crdt` / `test:crdt:extensive`     | PASS 349/6skip — 331/0 as above                                                                                                                  |
| `pnpm build`                                 | PASS (vite build + svelte-package + publint)                                                                                                     |
| `pnpm pack` + consumer                       | PASS (runtime + strict types)                                                                                                                    |
| `pnpm install --frozen-lockfile`             | PASS — lockfile unchanged by U01 edits                                                                                                           |
| `pnpm test:integration:serial`               | not re-run — known env limitation (missing firefox/webkit binaries), chromium green at U00                                                       |

## 8. Owned files / decisions / deviations

**Owned:** `src/lib/crdt/vendor/yjs/**` (incl. `dts/`, `UPSTREAM.md`,
`API-NOTES.md`), `vendor-tests/**`, `vitest.crdt.config.ts`,
`tsconfig.vendor-dts.json`, `scripts/regen-crdt-vendor-types.sh`,
`tests/packed-consumer/**`, `src/tests/crdt/v14-smoke.test.ts`; edits:
`package.json` (exports, engines, scripts), `tsconfig.json` + `.prettierignore`

- `eslint.config.js` (vendor excludes/ignores only).

**Decisions:** literal `lib0-v14` specifiers (no aliasing anywhere); upstream
tests outside `src/lib`; generated `dts/` committed (needed by `svelte-package`
→ dist); `./crdt` is a separate export — `src/lib/index.ts` untouched so the
main bundle stays v13-only until U08.

**Deviations from instructions:** none material. Pre-existing partial vendor
(P1 + dep pins + initial smoke test) was already in the working tree; I
verified it byte-faithful, fixed 3 wrong assertions in the smoke test
(v14 `slice`/`toString`/detached-delta semantics), and completed the rest.

**Not done (by design):** no runtime cutover (U08), no provider port (U07),
`v14-smoke.test.ts` not added to `tsconfig.tests.json` includes (pre-existing
pattern — `src/tests/crdt` isn't covered there; the file has `// @ts-nocheck`).

## 9. Blockers for U02

None. U02 gets: vendored engine at `src/lib/crdt/vendor/yjs/src/index.js`,
`lib0-v14` toolchain, upstream suite green, `test:crdt` lane, and the
packed-consumer harness for boundary checks.
