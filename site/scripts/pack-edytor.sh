#!/bin/sh
# Pack the editor from the repository root into vendor/edytor.tgz, the way a
# consumer installs it (one Svelte instance, the published file set).
#
# stage-tarballs.sh then stages it in public/ as edytor-<version>.tgz, which
# the deployed docs host at the root, beside every earlier version; with
# --deploy it refuses new bytes under a served version (see that script).
set -e
cd "$(dirname "$0")/../.."
pnpm package >/dev/null
mkdir -p site/vendor site/public
TGZ=$(pnpm pack --pack-destination site/vendor 2>/dev/null | tail -1)
mv -f "$TGZ" site/vendor/edytor.tgz
sh site/scripts/stage-tarballs.sh "$@"
