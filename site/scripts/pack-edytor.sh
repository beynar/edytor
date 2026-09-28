#!/bin/sh
# Pack the editor from the repository root into vendor/edytor.tgz, the way a
# consumer installs it (one Svelte instance, the published file set).
set -e
cd "$(dirname "$0")/../.."
pnpm package >/dev/null
mkdir -p site/vendor
TGZ=$(pnpm pack --pack-destination site/vendor 2>/dev/null | tail -1)
mv -f "$TGZ" site/vendor/edytor.tgz
echo "packed site/vendor/edytor.tgz"
