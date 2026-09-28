#!/usr/bin/env bash
# Materialize the PRISTINE upstream engine for interop/differential checks
# against the patched working tree (bench/lib/interop.mjs, bench/lib/engine-micro.mjs
# ENGINE_DIR, and the baseline leg of src/tests/crdt/hardening/r1-p4-format.test.ts).
#
# Source: the pinned `@y/y@14.0.0-rc.26` package (installed as the `@y/protocols`
# peer) — its `src/` is byte-identical to the vendored commit before patches
# P4–P8 (UPSTREAM.md). Only patch P1 (`lib0/` → `lib0-v14/`) is applied, so the
# baseline resolves the same lib0 build as the vendored engine.
#
# Before P8 this restored ynode.js/Item.js/RelativePosition.js from `git show
# HEAD:`, which stopped being a baseline once HEAD carried P4 (and a mixed tree
# no longer links against the pruned P8 modules).
#
# Output: bench/vendor-baseline/yjs/ (gitignored, never shipped).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SRC=$(node -e "
const { createRequire } = require('node:module');
const path = require('node:path');
const r = createRequire(require.resolve('@y/protocols/sync'));
console.log(path.dirname(r.resolve('@y/y')));
")
VERSION=$(node -e "console.log(require('$SRC/../package.json').version)")
if [ "$VERSION" != "14.0.0-rc.26" ]; then
	echo "expected @y/y 14.0.0-rc.26 (UPSTREAM.md pin), found $VERSION" >&2
	exit 1
fi
DST=bench/vendor-baseline/yjs

rm -rf "$DST"
mkdir -p "$DST"
cp -R "$SRC/." "$DST/"
# Patch P1 only.
find "$DST" -name '*.js' -exec sed -i.bak 's|lib0/|lib0-v14/|g' {} +
find "$DST" -name '*.js.bak' -delete

echo "pristine upstream baseline (@y/y $VERSION + P1) materialized at $DST"
