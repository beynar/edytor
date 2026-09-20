#!/usr/bin/env bash
# Regenerate TypeScript declarations for the vendored Yjs v14 engine.
#
# Mirrors upstream's `npm run dist` (tsc --emitDeclarationOnly over the
# JSDoc-annotated JS source, see upstream tsconfig.json), with two post-emit
# fixups that make the emitted tree self-contained:
#
#   1. `global.d.ts` is copied into the dts tree with its `import('./src/…')`
#      specifiers remapped to `./…` so ambient type aliases (Doc, Item, ID, …)
#      resolve against the *emitted* declarations instead of the JS sources.
#   2. A `/// <reference path="./global.d.ts" />` is prepended to
#      `dts/index.d.ts` so consumers of `edytor/crdt` get the ambient types.
#
# Expected caveat: tsc reports one `TS2589: Type instantiation is excessively
# deep` in `utils/delta-helpers.js` — an expression-level inference limit that
# does not block declaration emit (the emitted delta-helpers.d.ts is complete).
# The same diagnostic appears upstream when running plain `tsc` there.
#
# Usage: scripts/regen-crdt-vendor-types.sh   (from repo root)
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=src/lib/crdt/vendor/yjs

rm -rf "$VENDOR/dts"
pnpm exec tsc -p tsconfig.vendor-dts.json || {
	code=$?
	echo "tsc exited $code — TS2589 in delta-helpers.js is expected; verify emitted output below" >&2
}

# Fixup 1: ambient globals resolve against emitted d.ts, not JS sources.
sed -e "s|import('./src/|import('./|g" "$VENDOR/global.d.ts" > "$VENDOR/dts/global.d.ts"

# Fixup 2: index.d.ts pulls the ambient globals into the consumer's program.
printf '/// <reference path="./global.d.ts" />\n' | cat - "$VENDOR/dts/index.d.ts" > "$VENDOR/dts/index.d.ts.tmp"
mv "$VENDOR/dts/index.d.ts.tmp" "$VENDOR/dts/index.d.ts"

test -e "$VENDOR/dts/index.d.ts" && echo "emitted $(find "$VENDOR/dts" -name '*.d.ts' | wc -l | tr -d ' ') declaration files -> $VENDOR/dts"
