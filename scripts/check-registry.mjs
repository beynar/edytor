// The shadcn-svelte registry the docs site serves (`site/public/r/*.json`,
// https://edytor.dev/r/<item>.json) is current: built again from
// `registry.json` and `registry/` into a scratch folder, every item must
// equal the committed one. `pnpm registry:build` rewrites them.
//
//   node scripts/check-registry.mjs           # fails on a stale item
//   node scripts/check-registry.mjs --write   # same as pnpm registry:build
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVED = path.join(ROOT, 'site/public/r');
const BIN = path.join(ROOT, 'node_modules/.bin/shadcn-svelte');
const build = (output) =>
	execFileSync(BIN, ['registry', 'build', './registry.json', '--output', output], {
		cwd: ROOT,
		stdio: 'pipe'
	});

if (process.argv.includes('--write')) {
	build(SERVED);
	console.log('registry: site/public/r rewritten');
	process.exit(0);
}
const scratch = mkdtempSync(path.join(tmpdir(), 'edytor-registry-'));
try {
	build(scratch);
	const built = readdirSync(scratch).sort();
	const served = readdirSync(SERVED)
		.filter((name) => name.endsWith('.json'))
		.sort();
	const stale = [];
	if (built.join() !== served.join()) stale.push(`items: built ${built} / served ${served}`);
	for (const name of built)
		if (
			!served.includes(name) ||
			readFileSync(path.join(scratch, name), 'utf8') !==
				readFileSync(path.join(SERVED, name), 'utf8')
		)
			stale.push(name);
	if (stale.length) {
		console.error(`registry: stale ${stale.join(', ')}. Run pnpm registry:build.`);
		process.exit(1);
	}
	console.log(`registry: ${built.length} files current (${built.join(', ')})`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
