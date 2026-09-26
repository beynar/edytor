#!/usr/bin/env bash
# Materialize the pre-WU9 (git HEAD) vendored engine for interop/differential
# checks against the patched working tree. Output: bench/vendor-baseline/yjs/
# (gitignored, never shipped — package.json `files` only includes dist/).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SRC=src/lib/crdt/vendor/yjs/src
DST=bench/vendor-baseline/yjs

rm -rf "$DST"
mkdir -p "$DST"
cp -R "$SRC/." "$DST/"

# Restore the WU9-patched files to their HEAD (pre-patch) state.
for f in ynode.js structs/Item.js utils/RelativePosition.js; do
	mkdir -p "$DST/$(dirname "$f")"
	git show "HEAD:$SRC/$f" > "$DST/$f"
done

echo "baseline materialized at $DST"
