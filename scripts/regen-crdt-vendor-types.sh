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
# tsc runs clean since patch P8 (UPSTREAM.md) pruned `utils/delta-helpers.js`,
# the one module that tripped `TS2589: Type instantiation is excessively deep`
# upstream. The P7 declarations (`insertAtGapEnd*`) are emitted from their
# JSDoc like everything else — nothing in dts/ is hand-edited.
#
# Usage: scripts/regen-crdt-vendor-types.sh   (from repo root)
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=src/lib/crdt/vendor/yjs

rm -rf "$VENDOR/dts"
pnpm exec tsc -p tsconfig.vendor-dts.json || {
	code=$?
	echo "tsc exited $code — declarations may be incomplete; fix the JSDoc error above" >&2
	exit $code
}

# Fixup 1: ambient globals resolve against emitted d.ts, not JS sources.
sed -e "s|import('./src/|import('./|g" "$VENDOR/global.d.ts" > "$VENDOR/dts/global.d.ts"

# Fixup 2: index.d.ts pulls the ambient globals into the consumer's program.
printf '/// <reference path="./global.d.ts" />\n' | cat - "$VENDOR/dts/index.d.ts" > "$VENDOR/dts/index.d.ts.tmp"
mv "$VENDOR/dts/index.d.ts.tmp" "$VENDOR/dts/index.d.ts"

test -e "$VENDOR/dts/index.d.ts" && echo "emitted $(find "$VENDOR/dts" -name '*.d.ts' | wc -l | tr -d ' ') declaration files -> $VENDOR/dts"
