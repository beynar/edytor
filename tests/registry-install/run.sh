#!/bin/sh
# The starter registry, installed the way an app installs it: a fresh
# SvelteKit app (`sv create`, Tailwind v4, the Node adapter), shadcn-svelte's
# `init`, then `shadcn-svelte add <registry>/r/starter.json` from the registry
# built from this checkout and served locally, `edytor` replaced by this
# checkout's packed tarball; then the app type-checks, builds, and its server
# renders the starter page (title, properties, a date in the locale, blocks).
#
#   sh tests/registry-install/run.sh          # in a temporary folder
#   REGISTRY_WORK=/some/dir sh tests/registry-install/run.sh   # keep it there
#
# Needs network access (npm, the shadcn-svelte registry) and python3 (the
# CLI's prompts are answered with their defaults through a pseudo-terminal).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/tests/registry-install"
WORK=${REGISTRY_WORK:-$(mktemp -d)}
PORT=${REGISTRY_PORT:-4199}
SHADCN="shadcn-svelte@1.7.0"
mkdir -p "$WORK"
echo "==> work folder: $WORK"

echo "==> pack edytor and build the registry"
cd "$ROOT"
pnpm package >/dev/null
TGZ=$(pnpm pack --pack-destination "$WORK" 2>/dev/null | tail -1)
mv -f "$TGZ" "$WORK/edytor.tgz"
rm -rf "$WORK/registry"
mkdir -p "$WORK/registry"
./node_modules/.bin/shadcn-svelte registry build ./registry.json --output "$WORK/registry/r" >/dev/null
node "$HERE/serve.mjs" "$WORK/registry" "$PORT" &
SERVER=$!
APP_SERVER=
trap 'kill $SERVER ${APP_SERVER:-} 2>/dev/null || true' EXIT INT TERM

echo "==> sv create (SvelteKit, TypeScript, Tailwind v4, Node adapter)"
cd "$WORK"
rm -rf app
npx -y sv@latest create app --template minimal --types ts \
	--add tailwindcss="plugins:none" sveltekit-adapter="adapter:node" --install pnpm >/dev/null
cd app

echo "==> shadcn-svelte init"
python3 "$HERE/drive.py" npx -y "$SHADCN" init --base-color neutral >init.log 2>&1 ||
	{ cat init.log; exit 1; }
test -f components.json

echo "==> shadcn-svelte add http://localhost:$PORT/r/starter.json"
python3 "$HERE/drive.py" npx -y "$SHADCN" add "http://localhost:$PORT/r/starter.json" -y -o \
	>add.log 2>&1 || { cat add.log; exit 1; }
for file in edytor/starter/StarterEditor.svelte edytor/chrome/plugins.ts edytor/chrome/tokens.css \
	ui/button/index.ts ui/calendar/index.ts ui/command/index.ts; do
	test -e "src/lib/components/$file" || { echo "missing src/lib/components/$file"; cat add.log; exit 1; }
done
# The copied files name the app's aliases, never the registry's own.
if grep -rq '\$registry\|\$UI\$\|\$UTILS\$' src/lib/components/edytor; then
	echo 'the copied files still name the registry aliases'
	exit 1
fi
# This checkout's package, in place of the published one the item names.
pnpm add "$WORK/edytor.tgz" >/dev/null

# The app's components alias (`$lib/components`, or `#lib/components` on SvelteKit 3).
COMPONENTS=$(node -p "require('./components.json').aliases.components")
echo "    components alias: $COMPONENTS"
cat >src/routes/+page.svelte <<SVELTE
<script lang="ts">
	import { StarterEditor, type StarterProperty } from '$COMPONENTS/edytor/starter/index.js';
	import { createMemoryCommentsClient } from 'edytor';

	const properties: StarterProperty[] = [
		{ id: 'status', name: 'Status', type: 'select', options: [{ value: 'draft', label: 'Draft', color: 'gray' }] },
		{ id: 'due', name: 'Due', type: 'date' },
		{ id: 'tags', name: 'Tags', type: 'multi-select', options: [{ value: 'docs' }] },
		{ id: 'secret', name: 'Secret', type: 'text', hidden: true }
	];
	const comments = createMemoryCommentsClient({ user: 'ada' });
</script>

<StarterEditor
	{properties}
	{comments}
	people={[{ id: 'ada', label: 'Ada Lovelace' }]}
	user="ada"
	value={{
		data: { title: 'Registry page', properties: { status: 'draft', due: '2026-10-13', secret: 'kept' } },
		children: [{ type: 'paragraph', content: [{ text: 'Installed from the registry' }] }]
	}}
/>
SVELTE

echo "==> svelte-check"
pnpm exec svelte-kit sync >/dev/null
pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error

echo "==> vite build"
pnpm exec vite build >build.log 2>&1 || { tail -40 build.log; exit 1; }

echo "==> server render"
APP_PORT=$((PORT + 1))
PORT=$APP_PORT node build >server.log 2>&1 &
APP_SERVER=$!
for _ in $(seq 1 50); do
	curl -sf "http://localhost:$APP_PORT/" >page.html 2>/dev/null && break
	sleep 0.2
done
for text in 'data-edytor-starter' 'Registry page' 'Status' 'Draft' 'Oct 13, 2026' \
	'datetime="2026-10-13"' '1 hidden property' 'Installed from the registry'; do
	grep -q "$text" page.html || { echo "the server render lacks: $text"; exit 1; }
done
echo "==> registry install OK: the starter page server-renders ($(wc -c <page.html | tr -d ' ') bytes)"
