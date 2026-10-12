#!/bin/sh
# Pack the editor from the repository root into vendor/edytor.tgz, the way a
# consumer installs it (one Svelte instance, the published file set), and
# copy the demo's chrome into chrome/ for the live editor.
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
# The live editor draws the demo's chrome (the package ships none): a copy
# of src/routes/chrome importing the packed `edytor`, outside islands/ (blume
# makes every component there an island and prerenders it on the server).
rm -rf site/islands/chrome site/chrome
cp -R src/routes/chrome site/chrome
for file in site/chrome/*.svelte site/chrome/*.ts; do
	sed -i.orig "s#'\$lib/index.js'#'edytor'#" "$file" && rm "$file.orig"
done
sh site/scripts/stage-tarballs.sh "$@"
