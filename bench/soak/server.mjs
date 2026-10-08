/**
 * The soak's local room (WU-16): `local.ts` (the shipped `edytor/cloudflare`
 * room as `SoakRoom`, its operator routes and the eviction hook) bundled
 * with esbuild and served by Miniflare — the hosted lane's setup
 * (`tests/hosted/start.mjs`), with the production defaults (no lowered
 * frame limit, default quotas and compaction threshold, history in the
 * room's own SQLite) and workerd's inspector open, so the soak reads the
 * isolate's heap (`Runtime.getHeapUsage`).
 *
 * Usage: `node bench/soak/server.mjs [--port 4530] [--inspector 4531]`
 * (standalone, for a soak run against it with `--server`); `run.mjs`
 * starts it in-process unless given `--server`.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pluginRequire = createRequire(import.meta.resolve('@cloudflare/vitest-plugin'));

/**
 * Start the room on `port`; resolves with `{ url, heap, rss, dispose }`:
 * `heap()` the isolate's heap (`{ usedSize, totalSize }` bytes, `gc` first
 * when asked), `rss()` workerd's resident set (bytes, `null` when unread).
 */
export const startSoakRoom = async ({ port = 4530, inspectorPort = port + 1, vars = {} } = {}) => {
	const { Miniflare, Log, LogLevel } = pluginRequire('miniflare');
	const { build } = pluginRequire('esbuild');
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL('./local.ts', import.meta.url))],
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
		port,
		inspectorPort,
		cf: false,
		// `SOAK_VERBOSE=1`: workerd's own lines (resets, overloads) too.
		...(process.env.SOAK_VERBOSE ? { log: new Log(LogLevel.DEBUG), verbose: true } : {}),
		workers: [
			{
				config: {
					name: 'edytor-soak',
					compatibilityDate: '2026-09-26',
					compatibilityFlags: ['unsafe_module'],
					manifest: {
						mainModule: 'index.mjs',
						modulesRoot: '/',
						modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } }
					},
					env: {
						ROOM: { type: 'durable-object', worker: 'edytor-soak', exportName: 'SoakRoom' },
						EDYTOR_HISTORY: { type: 'text', value: 'room' },
						...Object.fromEntries(
							Object.entries(vars).map(([key, value]) => [
								key,
								{ type: 'text', value: String(value) }
							])
						)
					},
					exports: { SoakRoom: { type: 'durable-object', storage: 'sqlite' } }
				}
			}
		]
	});
	await miniflare.ready;
	const health = await miniflare.dispatchFetch(`http://127.0.0.1:${port}/health`);
	if ((await health.text()) !== 'ready') {
		await miniflare.dispose();
		throw new Error('soak room is not healthy');
	}
	const inspector = await connectInspector(inspectorPort);
	return {
		url: `http://127.0.0.1:${port}`,
		heap: (gc = false) => inspector.heap(gc),
		rss: () => workerd()?.rss ?? null,
		/** workerd's CPU use (percent of one core, as `ps` averages it). */
		cpu: () => workerd()?.cpu ?? null,
		dispose: async () => {
			inspector.close();
			await miniflare.dispose();
		}
	};
};

/** The `workerd` child of this process: its resident set (bytes) and CPU (%), or `null`. */
const workerd = () => {
	try {
		const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='], { encoding: 'utf8' });
		const row = out
			.trim()
			.split('\n')
			.map((line) => line.trim().split(/\s+/))
			.find(([, ppid, , , comm]) => Number(ppid) === process.pid && /workerd/.test(comm ?? ''));
		return row ? { rss: Number(row[2]) * 1024, cpu: Number(row[3]) } : null;
	} catch {
		return null;
	}
};

/**
 * A DevTools session on the Worker's isolate (workerd's inspector): the
 * heap the room's object lives in (one isolate holds the Worker and its
 * objects).
 */
const connectInspector = async (port) => {
	const failed = { heap: async () => null, close: () => {} };
	let targets;
	for (let attempt = 0; attempt < 20 && !targets?.length; attempt++) {
		try {
			targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	const target = targets?.find((t) => /edytor-soak/.test(t.title ?? t.url ?? '')) ?? targets?.[0];
	if (!target?.webSocketDebuggerUrl) return failed;
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	}).catch(() => null);
	if (socket.readyState !== WebSocket.OPEN) return failed;
	let id = 0;
	const waiting = new Map();
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(String(event.data));
		if (message.id !== undefined) waiting.get(message.id)?.(message);
		waiting.delete(message.id);
	});
	const call = (method, params = {}) =>
		new Promise((resolve) => {
			const n = ++id;
			waiting.set(n, resolve);
			socket.send(JSON.stringify({ id: n, method, params }));
			setTimeout(() => {
				if (waiting.delete(n)) resolve({ error: 'timeout' });
			}, 10_000);
		});
	return {
		heap: async (gc) => {
			if (gc) await call('HeapProfiler.collectGarbage');
			const answer = await call('Runtime.getHeapUsage');
			return answer.result ?? null;
		},
		close: () => socket.close()
	};
};

if (import.meta.url === `file://${process.argv[1]}`) {
	const arg = (name, fallback) => {
		const at = process.argv.indexOf(`--${name}`);
		return at === -1 ? fallback : Number(process.argv[at + 1]);
	};
	const room = await startSoakRoom({
		port: arg('port', 4530),
		inspectorPort: arg('inspector', 4531)
	});
	console.log(`edytor soak room ready on ${room.url} (heap: ${JSON.stringify(await room.heap())})`);
	const stop = async () => {
		await room.dispose();
		process.exit(0);
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}
