# Vendored Yjs v14 — provenance & patch manifest

This directory vendors the **unmodified** Yjs v14 engine source plus the exact
local patches applied on top. Do not edit files under `src/` by hand — apply a
recorded patch and document it here.

## Pinned source

| Field | Value |
| ----- | ----- |
| Upstream repo | `github.com/yjs/yjs` |
| Commit | `96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64` (upstream `main` HEAD at vendor time) |
| Upstream package | `@y/y@14.0.0-rc.26` (latest published release, 2026-09-07) |
| Tarball | `https://github.com/yjs/yjs/archive/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64.tar.gz` |
| Tarball SHA-256 | `4b5ad4100dcbd211fa33b420c0a992564e84286b654259a67e64c05af08d7b85` |
| License | MIT, © Kevin Jahns — see `LICENSE` |
| Upstream engines | `node >= 22.0.0`, `npm >= 8.0.0` (recorded in edytor `package.json#engines`) |

## Dependency pins (edytor `package.json` / `pnpm-lock.yaml`)

| Package | Pin | Purpose |
| ------- | --- | ------- |
| `lib0-v14` | `npm:lib0@1.0.0-rc.32` | the engine's `lib0` dep (`^1.0.0-rc.29` upstream), **aliased** so the v13 runtime keeps `lib0@0.2.117` |
| `lib0` | `^0.2.117` | unchanged — still used by `yjs@13.6.30`, `y-protocols`, `localProvider.ts` |
| `@y/protocols` | `1.0.6-rc.1` (devDep) | reference for U07 provider port; `@y/y` peer override-pinned to `14.0.0-rc.26` |
| `yjs` | `13.6.30` | unchanged — the live v13 runtime |

## Layout

```text
src/        upstream src/ verbatim, plus patch P1 (import specifier rewrite)
global.d.ts upstream global.d.ts verbatim, plus patch P1
dts/        generated TypeScript declarations (not upstream source — see below)
LICENSE     upstream MIT license, verbatim
UPSTREAM.md this file
```

Upstream test suite is vendored **outside** `src/lib` at
`vendor-tests/yjs/tests/` so it never ships in `dist`.

## Local patches

### P1 — `lib0/` → `lib0-v14/` import specifier rewrite (`src/**`, `global.d.ts`)

Reason: the repo keeps `lib0@0.2.117` for the v13 runtime; the v14 engine needs
`lib0@1.0.0-rc.32`. Both are real dependencies (`lib0` and the `lib0-v14` npm
alias), so the vendored source references `lib0-v14/*` literally — **no
Vite/bundler alias is involved at runtime or in the packed artifact**.

110 occurrences rewritten (imports and `import('lib0/…')` JSDoc references).
Reproduce:

```sh
# from the pristine upstream tree
find src -name '*.js' -exec sed -i '' 's|lib0/|lib0-v14/|g' {} +
sed -i '' 's|lib0/|lib0-v14/|g' global.d.ts
```

Verify: `grep -rn "lib0/" src global.d.ts | grep -v "lib0-v14/"` — only prose
mentions of "lib0" (comments) remain; every `lib0-v14` occurrence is followed
by `/`.

### P2 — vendored test specifier rewrite (`vendor-tests/yjs/tests/**`)

Same `lib0/` → `lib0-v14/` rewrite, plus relative `../src/` specifiers
retargeted to the vendored tree, plus the `@y/protocols/sync` import in
`testHelper.js` redirected to a local shim (P3). Reproduce:

```sh
cd vendor-tests/yjs/tests
find . -name '*.js' -exec sed -i '' \
  -e "s|from 'lib0/|from 'lib0-v14/|g" \
  -e "s|import('lib0/|import('lib0-v14/|g" \
  -e "s|from '\.\./src/|from '../../../src/lib/crdt/vendor/yjs/src/|g" \
  -e "s|import('\.\./src/|import('../../../src/lib/crdt/vendor/yjs/src/|g" \
  -e "s|from '@y/protocols/sync'|from './sync-shim.js'|g" {} +
```

### P3 — `vendor-tests/yjs/tests/sync-shim.js` (new file, test-only)

Verbatim port of `@y/protocols@1.0.6-rc.1` `src/sync.js` (MIT, Kevin Jahns)
with the engine import retargeted from `@y/y` to the vendored source and
`lib0/*` → `lib0-v14/*`. Required because the published `@y/protocols` would
construct a **second engine copy** from npm `@y/y`, breaking `instanceof`
checks against vendored docs. Test code only — not shipped.

## Generated declarations (`dts/`)

`svelte-package` copies JS verbatim but emits no `.d.ts` for JS inputs, so
declarations are generated the same way upstream does (`tsc` over the
JSDoc-annotated source):

```sh
scripts/regen-crdt-vendor-types.sh   # tsc -p tsconfig.vendor-dts.json + fixups
```

Emits `dts/**/*.d.ts` mirroring `src/` layout, plus `dts/global.d.ts` with
`import('./src/…')` → `import('./…'` remapped to the emitted tree and a
`/// <reference path="./global.d.ts" />` prepended to `dts/index.d.ts`.
Emitted types reference `lib0-v14/*` — resolved via the real dependency.

Known emit-time diagnostic (also present upstream): one `TS2589` ("type
instantiation excessively deep") in `utils/delta-helpers.js`; the emitted
`delta-helpers.d.ts` is still complete.

## Diffing against upstream

```sh
# fetch pristine source
curl -sL -o /tmp/yjs.tgz \
  https://github.com/yjs/yjs/archive/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64.tar.gz
shasum -a 256 /tmp/yjs.tgz   # expect 4b5ad410…8d7b85
tar -xzf /tmp/yjs.tgz -C /tmp
UP=/tmp/yjs-96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64

# engine source: normalize P1 away, then diff — must print nothing
mkdir -p /tmp/yjs-normalized && cp -R src/lib/crdt/vendor/yjs/src /tmp/yjs-normalized/
find /tmp/yjs-normalized -name '*.js' -exec sed -i '' 's|lib0-v14|lib0|g' {} +
diff -r "$UP/src" /tmp/yjs-normalized/src
diff "$UP/global.d.ts" <(sed 's|lib0-v14|lib0|g' src/lib/crdt/vendor/yjs/global.d.ts)
diff "$UP/LICENSE" src/lib/crdt/vendor/yjs/LICENSE

# tests: reverse P2 specifiers, then diff
cp -R vendor-tests/yjs/tests /tmp/yjs-tests-normalized
cd /tmp/yjs-tests-normalized && rm -f sync-shim.js && find . -name '*.js' -exec sed -i '' \
  -e "s|from 'lib0-v14/|from 'lib0/|g" -e "s|import('lib0-v14/|import('lib0/|g" \
  -e "s|from '../../../src/lib/crdt/vendor/yjs/src/|from '../src/|g" \
  -e "s|import('../../../src/lib/crdt/vendor/yjs/src/|import('../src/|g" \
  -e "s|from './sync-shim.js'|from '@y/protocols/sync'|g" {} +
diff -r "$UP/tests" /tmp/yjs-tests-normalized
```

## Upstream test record (this tree)

Runner: `vendor-tests/yjs/upstream.test.js` registers every `testXxx(tc)`
export as a vitest test with a real `lib0-v14/testing` `TestCase`.

- `pnpm test:crdt` — **325 pass / 6 skipped / 0 failed** (upstream standard
  tier; the 6 skips are upstream's own `t.skip(!t.production)` extensive-tier
  gates: 3× y-array, 3× y-map random stress tests).
- `pnpm test:crdt:extensive` (`PRODUCTION=1`) — **331 pass / 0 skip / 0 fail**
  (~200 s; includes the 30 000-op randomized stress test).
- Reproduce a seed: `YJS_TEST_SEED=<n> pnpm test:crdt`.
- Vitest runs each test once; upstream's `runTests` repeats `testRepeat*`
  cases for `--repetition-time` ms — that repetition loop is not replicated.
