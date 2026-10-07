/**
 * The package as a consumer installs it: `svelte-package` over `src/lib`
 * into `out` (never `dist/`), with `tsconfig.json`'s `stripInternal`, so a
 * member marked `@internal` is absent from the emitted declarations.
 *
 * Shared by `scripts/api-report.mjs` (`pnpm check:api`) and
 * `scripts/check-docs.mjs` (`pnpm check:docs`, whose examples resolve the
 * package's specifiers against this build).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

/** Build the package into `out` (emptied first). */
export const buildPackage = (out) => {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	// `tsconfig.json` extends the kit's generated one (`svelte-kit sync`).
	if (!existsSync(path.join(ROOT, '.svelte-kit/tsconfig.json')))
		execFileSync(
			process.execPath,
			[
				path.join(path.dirname(require.resolve('@sveltejs/kit/package.json')), 'svelte-kit.js'),
				'sync'
			],
			{ cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
		);
	const bin = path.join(
		path.dirname(require.resolve('@sveltejs/package/package.json')),
		'svelte-package.js'
	);
	execFileSync(process.execPath, [bin, '--input', 'src/lib', '--output', out], {
		cwd: ROOT,
		stdio: ['ignore', 'ignore', 'inherit']
	});
};
