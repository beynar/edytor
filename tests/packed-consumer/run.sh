#!/usr/bin/env bash
# Packed-consumer proof for the `edytor` package boundary (U01 + U12/PK01).
#
#   1. `pnpm pack` the real edytor package (runs svelte-package first).
#   2. Install the tarball into this fresh consumer dir.
#   3. node smoke.js  — runtime: engine via `edytor/crdt`, the full consumer
#      story via `edytor/crdt/edytor`, encapsulation rejects, and the
#      no-v13-engine install audit.
#      node smoke-worker.mjs — a Worker (`worker.js`) exporting the packed
#      `edytor/cloudflare` DocumentRoom behind routeDocumentSocket: esbuild
#      Worker bundle with no Svelte/DOM module, run in Miniflare (SQLite
#      storage) for `/health`, an authorize refusal, one sync round trip
#      with its saved acknowledgement over WebSocket upgrades, a forged
#      client id and a v13 frame refused. Needs the repo's
#      `@cloudflare/vitest-plugin` devDependency (esbuild + Miniflare).
#   4. tsc -p tsconfig.json         — node-safe surface under `nodenext`.
#      tsc -p tsconfig.bundler.json — full surface under `bundler` (the real
#      Svelte-consumer posture). Both strict, skipLibCheck OFF on purpose.
#
# Usage (from repo root): tests/packed-consumer/run.sh
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
ROOT="$HERE/../.."

echo "==> packing edytor"
cd "$ROOT"
pnpm package >/dev/null
TGZ=$(pnpm pack --pack-destination "$HERE" 2>/dev/null | tail -1)
cd "$HERE"
mv -f "$HERE/$(basename "$TGZ")" "$HERE/edytor.tgz" 2>/dev/null || mv -f "$TGZ" "$HERE/edytor.tgz" 2>/dev/null || true
ls -la edytor.tgz

# Provenance stamp (P2-8): record which src/lib content hash this tarball
# was packed from — bench/browser.js refuses to measure a tarball whose
# stamp disagrees with the current tree.
node --input-type=module -e "
import { hashTree } from '$ROOT/bench/lib/source-id.js';
import { writeFileSync } from 'node:fs';
writeFileSync('$HERE/edytor.src-sha256', hashTree('$ROOT/src/lib').sha256 + '\n');
"
cat edytor.src-sha256

echo "==> installing consumer"
rm -rf node_modules pnpm-lock.yaml package-lock.json
pnpm install --ignore-workspace 2>/dev/null || npm install --no-audit --no-fund

echo "==> runtime smoke (node)"
node smoke.js

echo "==> worker smoke (Worker bundle + Miniflare Durable Object round trip)"
node smoke-worker.mjs

echo "==> svelte consumer smoke (vite build + SSR + browser mount)"
node smoke-svelte.mjs

echo "==> typecheck node surface (tsc nodenext, skipLibCheck=false)"
pnpm exec tsc -p tsconfig.json || npx --yes typescript@5.9 tsc -p tsconfig.json

echo "==> typecheck full surface (tsc bundler, skipLibCheck=false)"
pnpm exec tsc -p tsconfig.bundler.json || npx --yes typescript@5.9 tsc -p tsconfig.bundler.json

echo "ALL PACKED-CONSUMER CHECKS PASSED"
