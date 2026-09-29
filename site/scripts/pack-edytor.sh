#!/bin/sh
# Pack the editor from the repository root into vendor/edytor.tgz, the way a
# consumer installs it (one Svelte instance, the published file set).
#
# The same tarball is copied to public/edytor-<version>.tgz: Blume serves
# public/ at the site root, so the deployed docs host the pre-release at
# https://edytor-docs.beynar.workers.dev/edytor-<version>.tgz, the URL the
# install instructions give. Older tarballs are removed so the site serves
# exactly the version the docs describe.
set -e
cd "$(dirname "$0")/../.."
pnpm package >/dev/null
mkdir -p site/vendor site/public
TGZ=$(pnpm pack --pack-destination site/vendor 2>/dev/null | tail -1)
mv -f "$TGZ" site/vendor/edytor.tgz
VERSION=$(node -p "require('./package.json').version")
rm -f site/public/edytor-*.tgz
cp site/vendor/edytor.tgz "site/public/edytor-$VERSION.tgz"
echo "packed site/vendor/edytor.tgz and site/public/edytor-$VERSION.tgz"
