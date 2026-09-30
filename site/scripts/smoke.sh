#!/bin/sh
# Post-deploy smoke check: every hosted tarball (served-versions.txt: a
# lockfile may pin any of them), and the pages the install instructions and
# error messages send readers to, answer 200, the current tarball is the one
# this deploy packed, and the site's live editor and the room were built from
# it (installed-edytor.sh).
set -e
cd "$(dirname "$0")/../.."
sh site/scripts/installed-edytor.sh
SITE=$(sed -n 's/.*cloudflare({ *site: *"\([^"]*\)".*/\1/p' site/blume.config.ts)
VERSION=$(node -p "require('./package.json').version")
for path in "/edytor-$VERSION.tgz" /docs/reference/troubleshooting /docs/getting-started; do
	curl -fsI --retry 6 --retry-all-errors --retry-delay 5 "$SITE$path" >/dev/null || {
		echo "smoke: $SITE$path does not answer 200" >&2
		exit 1
	}
done
for v in $(sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' site/scripts/served-versions.txt); do
	curl -fsI --retry 6 --retry-all-errors --retry-delay 5 "$SITE/edytor-$v.tgz" >/dev/null || {
		echo "smoke: $SITE/edytor-$v.tgz is gone, and lockfiles may pin it" >&2
		exit 1
	}
done
# The demo room behind the landing page's live editor answers, and a dial of
# a closed day's room from the docs origin is accepted and closed 4404. A
# plain GET answers 404 on every build; only a current one closes the socket.
WSS=$(sed -n "s|.*'\(wss://[^']*\)/rooms'.*|\1/rooms|p" site/islands/LiveEditor.svelte)
ROOM=$(echo "$WSS" | sed -e 's|^wss://|https://|' -e 's|/rooms$||')
[ "$(curl -s -o /dev/null -w '%{http_code}' "$ROOM/health")" = 200 ] || {
	echo "smoke: $ROOM/health does not answer 200" >&2
	exit 1
}
node site/scripts/probe-room.mjs "$WSS/demo-2019-01-01?guest=smoke-probe-1" "$SITE" 4404 || {
	echo "smoke: $ROOM does not close a closed room's dial with 4404 (an old build: redeploy site/room)" >&2
	exit 1
}
LIVE=$(mktemp)
curl -fsS -o "$LIVE" "$SITE/edytor-$VERSION.tgz"
if ! cmp -s "$LIVE" "site/public/edytor-$VERSION.tgz"; then
	rm -f "$LIVE"
	echo "smoke: $SITE/edytor-$VERSION.tgz is not the tarball this deploy packed" >&2
	exit 1
fi
rm -f "$LIVE"
echo "smoke: $SITE serves edytor-$VERSION.tgz, every earlier tarball, the docs and the demo room"
