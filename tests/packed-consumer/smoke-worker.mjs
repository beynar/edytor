/**
 * Worker smoke for the packed package (run by run.sh after the node smoke):
 *
 * 1. esbuild-bundle `worker.js` — the installed `edytor/cloudflare` room
 *    (`DocumentRoom` + `routeDocumentSocket`) — for a Worker target, and
 *    assert the bundle reaches the cloudflare and CRDT dist and no Svelte /
 *    DOM view module (`dist/components/`, `*.svelte`, the component root…).
 * 2. Run it in Miniflare (no port: `dispatchFetch`) with the room on SQLite
 *    storage: `/health`, a refused authorization (closed 4403), then one sync round
 *    trip over WebSocket upgrades — a writer pushes a seeded document and
 *    gets the room's store-before-ack state vector, a second socket syncs
 *    it back — an update under the writer's client id from another user is
 *    refused (1008), and a frame of another generation is refused (1008).
 *
 * esbuild and Miniflare are the versions the repo's
 * `@cloudflare/vitest-plugin` devDependency owns (resolved from the repo
 * root, `EDYTOR_REPO_ROOT` overrides it).
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'edytor/crdt';
import * as E from 'edytor/crdt/edytor';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.EDYTOR_REPO_ROOT ?? join(HERE, '../..'));
const pluginRequire = createRequire(
	realpathSync(join(ROOT, 'node_modules/@cloudflare/vitest-plugin/package.json'))
);
const { build } = pluginRequire('esbuild');
const { Miniflare } = pluginRequire('miniflare');

// ── 1 · bundle boundary ──────────────────────────────────────────────────
const bundle = await build({
	entryPoints: [join(HERE, 'worker.js')],
	absWorkingDir: HERE,
	bundle: true,
	format: 'esm',
	platform: 'browser',
	conditions: ['workerd', 'worker', 'browser'],
	target: 'es2022',
	external: ['cloudflare:workers'],
	metafile: true,
	write: false,
	logLevel: 'warning'
});
const inputs = Object.keys(bundle.metafile.inputs);
const edytorInputs = inputs.filter((path) => path.includes('node_modules/edytor/'));
assert.ok(
	edytorInputs.some((path) => path.endsWith('/dist/cloudflare/index.js')),
	'the Worker bundle must include edytor/cloudflare (dist/cloudflare/index.js)'
);
assert.ok(
	edytorInputs.some((path) => path.endsWith('/dist/crdt/index.js')),
	'the Worker bundle must include edytor/crdt/edytor (dist/crdt/index.js)'
);
assert.ok(
	edytorInputs.some((path) => path.endsWith('/dist/crdt/vendor/yjs/src/index.js')),
	'the Worker bundle must include the vendored engine (edytor/crdt)'
);
const VIEW =
	/\/dist\/(components|plugins|selection|surface|session|events|block|text|hotkeys|clipboard|collaboration|dnd)\/|\/dist\/index\.js$|\/dist\/edytor[^/]*$|\.svelte(\.[jt]s)?$/;
// The Worker-safe module set (WORKER_SAFE in the repo's eslint.config.js).
const WORKER_SAFE = /\/dist\/(crdt\/.*|cloudflare\/.*|utils\/json\.js|utils\.js|constants\.js)$/;
const breaches = inputs.filter(
	(path) =>
		VIEW.test(path) ||
		/(^|\/)node_modules\/(svelte|@sveltejs)\//.test(path) ||
		(path.includes('node_modules/edytor/') && !WORKER_SAFE.test(path))
);
assert.deepEqual(breaches, [], 'the Worker bundle must not reach Svelte or DOM view modules');
console.log(
	`worker bundle: ${inputs.length} modules (${edytorInputs.length} from edytor's Worker-safe dist), ${(
		bundle.outputFiles[0].contents.length / 1024
	).toFixed(0)} KiB, no Svelte/DOM modules`
);

// ── 2 · run it ───────────────────────────────────────────────────────────
const miniflare = new Miniflare({
	cf: false,
	workers: [
		{
			config: {
				name: 'packed-edytor-room',
				compatibilityDate: '2026-09-26',
				manifest: {
					mainModule: 'index.mjs',
					modulesRoot: '/',
					modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } }
				},
				env: {
					ROOM: { type: 'durable-object', worker: 'packed-edytor-room', exportName: 'DocumentRoom' }
				},
				exports: { DocumentRoom: { type: 'durable-object', storage: 'sqlite' } }
			}
		}
	]
});

const crdt = E.bindCrdt(Y);
const sync = crdt.sync;

/** Open a socket to `room` (as `query`'s user) and collect its frames / close event. */
const dial = async (room, query = '') => {
	const response = await miniflare.dispatchFetch(`http://local/rooms/${room}${query}`, {
		headers: { Upgrade: 'websocket' }
	});
	const ws = response.webSocket;
	assert.ok(ws, `upgrade refused: ${response.status}`);
	const frames = [];
	let closed = null;
	ws.addEventListener('message', (event) => frames.push(new Uint8Array(event.data)));
	ws.addEventListener('close', (event) => (closed = { code: event.code, reason: event.reason }));
	ws.accept();
	return { ws, frames, closed: () => closed };
};

const until = async (cond, what, timeout = 5000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};

try {
	await miniflare.ready;
	const health = await miniflare.dispatchFetch('http://local/health');
	assert.equal(await health.text(), 'ready');
	const denied = await dial('smoke', '?user=denied');
	await until(() => denied.closed() !== null, 'the denial close');
	assert.deepEqual(
		denied.closed(),
		{ code: 4403, reason: 'document access denied' },
		'authorize refuses before the room'
	);

	// Writer: a seeded headless document pushed as one Update frame.
	const writer = E.createDocument({
		value: { children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'packed Worker' }] }] },
		actor: { id: 'packed-writer' }
	});
	const a = await dial('smoke', `?user=writer&replica=${writer.doc.clientID}`);
	await until(() => a.frames.length > 0, 'the room SyncStep1');
	const first = E.createDecoder(a.frames[0]);
	assert.equal(E.readProtocolVersion(first), true, 'the room speaks this generation');
	a.ws.send(E.frame(E.messageSync, (e) => sync.writeUpdate(e, Y.encodeStateAsUpdate(writer.doc))));
	// Store-before-ack: the room answers with its state vector, covering the write.
	const own = writer.doc.clientID;
	const clock = Y.decodeStateVector(Y.encodeStateVector(writer.doc)).get(own);
	await until(
		() =>
			a.frames.some((bytes) => {
				const decoder = E.createDecoder(bytes);
				if (!E.readProtocolVersion(decoder) || E.readVarUint(decoder) !== E.messageSaved)
					return false;
				return Y.decodeStateVector(E.readVarUint8Array(decoder)).get(own) === clock;
			}),
		'the saved acknowledgement'
	);

	// Reader: a fresh engine doc syncs the room's state back.
	const b = await dial('smoke');
	const reader = crdt.createDoc();
	let step2 = false;
	b.ws.send(E.frame(E.messageSync, (e) => sync.writeSyncStep1(e, reader)));
	await until(() => {
		for (const bytes of b.frames.splice(0)) {
			const decoder = E.createDecoder(bytes);
			if (!E.readProtocolVersion(decoder) || E.readVarUint(decoder) !== E.messageSync) continue;
			const type = E.readVarUint(decoder);
			const payload = E.readVarUint8Array(decoder);
			if (type === E.messageYjsSyncStep1) continue;
			const { applied, problem } = sync.applyRemote(reader, payload, 'room');
			assert.ok(applied && problem === null, 'the reader admits the room state');
			step2 ||= type === E.messageYjsSyncStep2;
		}
		return step2;
	}, 'the round trip');
	const facade = crdt.doc.create(reader);
	assert.equal(facade.blockText('p1'), 'packed Worker');
	assert.deepEqual(facade.toJSON(), writer.facade.toJSON());
	facade.dispose();

	// Another user writing under the writer's client id is refused.
	const forgedDoc = crdt.createDoc();
	Y.applyUpdate(forgedDoc, Y.encodeStateAsUpdate(writer.doc));
	forgedDoc.clientID = own;
	const forged = [];
	forgedDoc.on('update', (u) => forged.push(u));
	const forger = E.attachDocument(forgedDoc, { actor: { id: 'mallory' } });
	forger.facade.insertText('p1', 0, 'FORGED ');
	forger.destroy();
	const mallory = await dial('smoke', '?user=mallory');
	mallory.ws.send(E.frame(E.messageSync, (e) => sync.writeUpdate(e, Y.mergeUpdates(forged))));
	await until(() => mallory.closed() !== null, 'the forged-client refusal');
	assert.deepEqual(mallory.closed(), { code: 1008, reason: 'refused: replica' });

	// A v13-era frame (no generation word: `messageSync, messageYjsUpdate, …`) is refused.
	const rogue = await dial('smoke');
	rogue.ws.send(Uint8Array.from([E.messageSync, E.messageYjsUpdate, 2, 0, 0]));
	await until(() => rogue.closed() !== null, 'the refusal');
	assert.equal(rogue.closed().code, 1008);

	a.ws.close(1000, 'done');
	b.ws.close(1000, 'done');
	writer.destroy();
	console.log('Packed Worker bundle + Durable Object round trip passed');
} finally {
	await miniflare.dispose();
}
