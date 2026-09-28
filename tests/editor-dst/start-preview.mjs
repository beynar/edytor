import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const repository = join(harnessDirectory, '..', '..');
const runtime = mkdtempSync(join(tmpdir(), 'edytor-dst-'));
process.title = `edytor-dst-preview:${basename(runtime)}`;
const excludedRoots = new Set([
	'.artifacts',
	'.git',
	'.svelte-kit',
	'build',
	'dist',
	'node_modules',
	'playwright-report',
	'test-results'
]);

const shouldCopy = (source) => {
	const path = relative(repository, source);
	if (!path) return true;
	if (
		!path.includes('/') &&
		!path.includes('\\') &&
		(path === '.env' || path.startsWith('.env.'))
	) {
		return false;
	}
	return !path.split(/[\\/]/).some((segment) => excludedRoots.has(segment));
};

const cleanup = () => rmSync(runtime, { recursive: true, force: true });

let activeChild = null;
let requestedSignal = null;

const signalChild = (child, signal) => {
	if (process.platform === 'win32' || child.pid === undefined) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (!error || typeof error !== 'object' || error.code !== 'ESRCH') throw error;
	}
};

const stop = (signal) => {
	requestedSignal ??= signal;
	if (activeChild) signalChild(activeChild, signal);
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', cleanup);

const run = (args) =>
	new Promise((resolve, reject) => {
		const child = spawn('pnpm', args, {
			cwd: runtime,
			env: process.env,
			stdio: 'inherit',
			detached: process.platform !== 'win32'
		});
		activeChild = child;
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (activeChild === child) activeChild = null;
			resolve({ code, signal });
		});
		if (requestedSignal) signalChild(child, requestedSignal);
	});

try {
	cpSync(repository, runtime, { recursive: true, filter: shouldCopy });
	symlinkSync(join(repository, 'node_modules'), join(runtime, 'node_modules'), 'dir');
	const build = await run(['exec', 'vite', 'build']);
	if (requestedSignal) {
		process.exitCode = 0;
	} else if (build.code !== 0) {
		process.exitCode = build.code ?? 1;
	} else {
		const preview = await run([
			'exec',
			'vite',
			'preview',
			'--host',
			'127.0.0.1',
			'--port',
			process.env.DST_PORT ?? '4183'
		]);
		process.exitCode = requestedSignal || preview.signal ? 0 : (preview.code ?? 0);
	}
} finally {
	cleanup();
}
