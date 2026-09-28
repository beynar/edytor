/**
 * The hosted lane's server: bundle `tests/hosted/worker.ts` (the `tests/do`
 * room + a test-only eviction hook) with esbuild and serve it from Miniflare
 * on 127.0.0.1:4195 — ROOM Durable Object on SQLite storage, `/health`.
 * esbuild and Miniflare are the versions `@cloudflare/vitest-plugin` owns.
 *
 * Usage (from the repo root): node tests/hosted/start.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pluginRequire = createRequire(import.meta.resolve('@cloudflare/vitest-plugin'));
const { Miniflare } = pluginRequire('miniflare');
const { build } = pluginRequire('esbuild');

export const HOSTED_PORT = Number(process.env.EDYTOR_HOSTED_PORT ?? 4195);

const bundle = await build({
	entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
	absWorkingDir: root,
	bundle: true,
	format: 'esm',
	platform: 'browser',
	conditions: ['workerd', 'worker', 'browser'],
	target: 'es2022',
	external: ['cloudflare:workers', 'workerd:unsafe'],
	write: false,
	logLevel: 'warning'
});

const miniflare = new Miniflare({
	host: '127.0.0.1',
	port: HOSTED_PORT,
	cf: false,
	workers: [
		{
			config: {
				name: 'edytor-hosted',
				compatibilityDate: '2026-09-26',
				compatibilityFlags: ['unsafe_module'],
				manifest: {
					mainModule: 'index.mjs',
					modulesRoot: '/',
					modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } }
				},
				env: {
					ROOM: { type: 'durable-object', worker: 'edytor-hosted', exportName: 'Room' }
				},
				exports: { Room: { type: 'durable-object', storage: 'sqlite' } }
			}
		}
	]
});

try {
	await miniflare.ready;
	const health = await miniflare.dispatchFetch(`http://127.0.0.1:${HOSTED_PORT}/health`);
	if ((await health.text()) !== 'ready') throw new Error('hosted worker is not healthy');
	console.log(`edytor hosted room ready on http://127.0.0.1:${HOSTED_PORT}`);
} catch (error) {
	await miniflare.dispose();
	throw error;
}

const stop = async () => {
	await miniflare.dispose();
	process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
