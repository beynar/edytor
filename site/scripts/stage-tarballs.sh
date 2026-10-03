#!/bin/sh
# Stage the packed site/vendor/edytor.tgz in site/public/ as
# edytor-<version>.tgz. Blume serves public/ at the site root, so the deployed
# docs host it at $SITE/edytor-<version>.tgz, the URL the install
# instructions give.
#
# A hosted tarball URL is permanent: a consumer's lockfile pins both the URL
# and the integrity of its bytes. So public/ holds every version listed in
# served-versions.txt (the pre-releases the site has ever served), and
# nothing else. With --deploy (the site's `pnpm run deploy`):
#   - the version in package.json must be listed there;
#   - new bytes under a version the site already serves are refused: bump the
#     pre-release version (0.1.0-next.0 -> 0.1.0-next.1) and list it;
#   - each earlier version is staged from the live site's bytes, so a fresh
#     clone keeps serving it and a stale local copy never replaces it.
# The deploy is refused when the live site cannot be read. FORCE=1 skips the
# checks (an earlier version then keeps its local copy, if any). KEEP_LIVE=1
# (the CI deploy on a push to master, whose pack may differ from the one a
# release served) keeps serving a served version's live bytes instead of
# refusing.
# SITE overrides the site origin from blume.config.ts.
set -e
cd "$(dirname "$0")/../.."
SITE=${SITE:-$(sed -n 's/.*cloudflare({ *site: *"\([^"]*\)".*/\1/p' site/blume.config.ts)}
VERSION=$(node -p "require('./package.json').version")
SERVED=site/scripts/served-versions.txt

versions() { sed -e 's/#.*//' -e 's/[[:space:]]//g' -e '/^$/d' "$SERVED"; }
listed() { versions | grep -qxF "$1"; }
refuse() {
	echo "refused: $1" >&2
	echo "$2" >&2
	exit 1
}
# Download $SITE/edytor-$1.tgz to $2; print the HTTP status (000 when unreachable).
fetch() { curl -sS -o "$2" -w '%{http_code}' "$SITE/edytor-$1.tgz" 2>/dev/null || true; }

LIVE=$(mktemp -d)
trap 'rm -rf "$LIVE"' EXIT

if [ "$1" = "--deploy" ] && [ "$FORCE" != 1 ]; then
	listed "$VERSION" ||
		refuse "$VERSION is not listed in $SERVED." \
			"List it there: the next deploy keeps only listed versions, and a lockfile may pin this one."
	STATUS=$(fetch "$VERSION" "$LIVE/current")
	if [ "$STATUS" = 200 ] && [ "$KEEP_LIVE" = 1 ]; then
		cmp -s "$LIVE/current" site/vendor/edytor.tgz ||
			echo "kept: $SITE/edytor-$VERSION.tgz serves its live bytes (this pack differs)" >&2
		CURRENT="$LIVE/current"
	elif [ "$STATUS" = 200 ]; then
		cmp -s "$LIVE/current" site/vendor/edytor.tgz ||
			refuse "$SITE/edytor-$VERSION.tgz already serves different bytes." \
				"Bump the pre-release version in package.json and list it in $SERVED, or rerun with FORCE=1."
	elif [ "$STATUS" != 404 ]; then
		refuse "could not read $SITE/edytor-$VERSION.tgz (HTTP $STATUS) to compare." \
			"Rerun when the site answers, or with FORCE=1 to skip the check."
	fi
	for v in $(versions); do
		[ "$v" = "$VERSION" ] && continue
		STATUS=$(fetch "$v" "$LIVE/edytor-$v.tgz")
		[ "$STATUS" = 200 ] ||
			refuse "could not read $SITE/edytor-$v.tgz (HTTP $STATUS) to keep serving it." \
				"A lockfile may pin it. Rerun when the site answers, or with FORCE=1 to deploy without it."
	done
fi

mkdir -p site/public
for f in site/public/edytor-*.tgz; do
	[ -e "$f" ] || continue
	v=${f#site/public/edytor-}
	v=${v%.tgz}
	[ "$v" = "$VERSION" ] || listed "$v" || rm -f "$f"
done
for f in "$LIVE"/edytor-*.tgz; do
	[ -e "$f" ] && mv -f "$f" site/public/
done
cp "${CURRENT:-site/vendor/edytor.tgz}" "site/public/edytor-$VERSION.tgz"
echo "staged site/public/edytor-$VERSION.tgz beside $(versions | grep -cvxF "$VERSION") earlier version(s)"
