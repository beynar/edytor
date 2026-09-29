#!/bin/sh
# The site's live editor (site/islands/LiveEditor.svelte) and the demo room
# (site/room) bundle the edytor pnpm installed from vendor/edytor.tgz at their
# last install, not the tarball itself: a repack alone leaves them on the
# earlier build. Refuse unless both installs hold the packed bytes; pnpm
# records the integrity of what it installed in node_modules/.pnpm/lock.yaml.
set -e
cd "$(dirname "$0")/.."
PACKED=$(node -p "'sha512-' + require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync('vendor/edytor.tgz')).digest('base64')")
for dir in site room; do
	lock=node_modules/.pnpm/lock.yaml
	install="pnpm install"
	[ "$dir" = room ] && lock=room/$lock && install="pnpm --dir room install"
	grep -qF "integrity: $PACKED, tarball: file:" "$lock" 2>/dev/null || {
		echo "installed-edytor: the $dir does not have vendor/edytor.tgz installed: run \`$install\` in site/" >&2
		exit 1
	}
done
echo "installed-edytor: the site and the room bundle vendor/edytor.tgz"
