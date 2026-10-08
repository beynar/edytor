/**
 * Runtime smoke for the packed `edytor/crdt` export (vendored Yjs v14 engine)
 * plus the public package boundary (`edytor` root + `edytor/crdt/edytor`).
 * Run by run.sh after `pnpm install` of the packed tarball.
 */
import * as Y from 'edytor/crdt';
import assert from 'node:assert/strict';

// Doc + unified Node
const doc = new Y.Doc();
const root = doc.get('content');
assert.ok(root instanceof Y.Node);
root.setAttr('type', 'root');

// sequence + format + maintained delta
const para = new Y.Node('paragraph');
root.insert(0, [para]);
para.insert(0, 'hello world');
para.format(6, 5, { bold: true });
assert.deepEqual(para.delta.toJSON().children, [
	{ type: 'insert', insert: 'hello ' },
	{ type: 'insert', insert: 'world', format: { bold: true } }
]);

// update round-trip between two docs
const doc2 = new Y.Doc();
Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
assert.equal(doc2.get('content').get(0).toString(), '<paragraph>hello world</paragraph>');

// relative positions
const rpos = Y.createRelativePositionFromTypeIndex(para, 3);
const abs = Y.createAbsolutePositionFromRelativePosition(
	Y.createRelativePositionFromJSON(Y.relativePositionToJSON(rpos)),
	doc
);
assert.equal(abs.index, 3);
assert.equal(abs.type, para);

// UndoManager
const um = new Y.UndoManager(doc);
doc.transact(() => para.insert(11, '!'));
um.undo();
assert.equal(para.toString(), '<paragraph>hello world</paragraph>');
um.redo();
assert.equal(para.toString(), '<paragraph>hello world!</paragraph>');

// ── package boundary: node-safe subpaths vs the component root ───────────
//
// `import 'edytor'` (the package root) re-exports the Svelte component —
// `dist/index.js` statically reaches `./components/Edytor.svelte`, which a
// bundler (the consumer's vite-plugin-svelte) compiles but plain node cannot
// resolve. That is the standard svelte-package shape, not a defect: the
// node-safe surface is the dedicated bindings subpath `edytor/crdt/edytor`.
// Assert the boundary explicitly so nobody re-learns it the hard way.
await assert.rejects(
	() => import('edytor'),
	(err) => err.code === 'ERR_UNKNOWN_FILE_EXTENSION' && String(err.message).includes('.svelte'),
	"plain node cannot load the '.svelte' component export — expected"
);

// `edytor/crdt/edytor` — the bindings subpath (the engine path `edytor/crdt`
// stays the raw vendored module). This is THE public surface for
// node/SSR-side CRDT work: Doc, facade, awareness, providers, migration.
const bindings = await import('edytor/crdt/edytor');
assert.equal(typeof bindings.bindCrdt, 'function');
assert.equal(typeof bindings.Awareness, 'function');
// D-15 (C1): the `bind*` building blocks are internal — `bindCrdt(Y)` is the
// one composition entry (`.doc`, `.providers`, `.migration`, `.sync`, …).
for (const retired of [
	'bindEdytorDoc',
	'bindMigration',
	'bindProviders',
	'bindRuns',
	'decorateRuns'
])
	assert.equal(bindings[retired], undefined, `${retired} is retired`);
// The server-coordinator surface is `edytor/protocol` (a Durable Object
// imports only these), never the document entry.
const protocol = await import('edytor/protocol');
for (const name of [
	'frame',
	'generationWord',
	'readProtocolVersion',
	'readAwarenessEntries',
	'writeAwarenessEntries',
	'createDecoder'
]) {
	assert.equal(typeof protocol[name], 'function', name);
	assert.equal(bindings[name], undefined, `${name} is not on edytor/crdt/edytor`);
}
assert.equal(protocol.GENERATION, protocol.generationWord(protocol.SCHEMA_VERSION));
assert.equal(protocol.bindCrdt, bindings.bindCrdt);
assert.equal(typeof protocol.WebsocketProvider, 'function');

// bindCrdt actually assembles: doc + facade + awareness + providers + sync.
const crdt = bindings.bindCrdt(Y);
const doc3 = crdt.createDoc();
const awareness = new crdt.Awareness(doc3);
assert.ok(doc3 instanceof Y.Doc);
assert.ok(awareness instanceof bindings.Awareness);
const ed = crdt.doc.create(doc3);
ed.init();
const bootstrap = ed.childrenIds(null)[0];
ed.insertText(bootstrap, 0, 'via bindCrdt');
assert.ok(JSON.stringify(ed.toJSON()).includes('via bindCrdt'));
// The supported undo seam exists and is usable.
const edUm = ed.createUndoManager({ captureTimeout: 0 });
ed.insertText(bootstrap, 0, 'UNDO-');
edUm.undo();
assert.ok(!JSON.stringify(ed.toJSON()).includes('UNDO-'));
ed.dispose();
// Awareness owns a stale-state sweep interval — doc destroy cascades to it
// (clearInterval) or node never exits.
doc3.destroy();
assert.equal(awareness.getLocalState(), null);

// Providers construct through the bound stack (no engine import inside).
assert.equal(typeof crdt.providers.IndexeddbPersistence, 'function');
assert.equal(typeof crdt.providers.WebsocketProvider, 'function');
assert.equal(typeof crdt.migration.migrate, 'function');
assert.equal(typeof crdt.sync.readSyncMessage, 'function');

// The README-documented sync factories ship on the package root for Svelte
// consumers (`import { Edytor, createIndexeddbSync } from 'edytor'` — checked
// at type level by smoke-types.ts) AND on the bound provider stack here, so
// the same wiring is reachable without the component root.
assert.equal(typeof crdt.providers.createIndexeddbSync, 'function');
assert.equal(typeof crdt.providers.createWebsocketSync, 'function');
// Local persistence by default, named after the server and room (skipped
// at runtime here: Node has no indexedDB).
assert.equal(
	crdt.providers.createWebsocketSync({ server: 'wss://example.com/', room: 'r' }).persistName,
	'edytor:wss://example.com/r'
);

// ── the real consumer story (U12/PK01) ───────────────────────────────────
// Doc + Awareness via public exports → `bindCrdt(Y).doc` facade → init →
// insert a block + text → two docs converge via update exchange → destroy.

const docA = crdt.createDoc();
const docB = crdt.createDoc();
const awarenessA = new crdt.Awareness(docA);
const awarenessB = new crdt.Awareness(docB);
awarenessA.setLocalStateField('user', { name: 'Ada', color: '#dc2626' });

const edA = crdt.doc.create(docA);
edA.init(); // deterministic bootstrap — one canonical empty block
const boot = edA.childrenIds(null)[0];
assert.equal(typeof boot, 'string');
edA.insertText(boot, 0, 'Hello, ');
assert.ok(edA.insertBlock({ parent: null, index: 1 }, { id: 'b-world', type: 'paragraph' }));
edA.insertText('b-world', 0, 'world');
edA.formatRange('b-world', 0, 5, { bold: true });
assert.equal(edA.blockText('b-world'), 'world');

// State-vector exchange — the exact dance providers run on join.
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
const edB = crdt.doc.create(docB);
edB.assertSchema(); // the synced replica passes the application-schema gate
assert.equal(edB.schemaVersion(), protocol.SCHEMA_VERSION);
assert.deepEqual(edB.toJSON(), edA.toJSON());
assert.equal(edB.blockText('b-world'), 'world');

// B edits; the incremental update converges A — both replicas identical.
edB.insertText('b-world', 5, '!');
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
assert.deepEqual(edA.toJSON(), edB.toJSON());
assert.equal(edA.blockText('b-world'), 'world!');

// Clean teardown: facade dispose, doc destroy (cascades to awareness).
edA.dispose();
edB.dispose();
docA.destroy();
docB.destroy();
assert.equal(awarenessA.getLocalState(), null);
assert.equal(awarenessB.getLocalState(), null);

// ── the integrated document API (U9 — the headline surface) ────────────
// `createDocument`/`loadDocument`/`attachDocument` are bound to the
// vendored engine at module level — no `bindCrdt` call, no engine
// injection, no component import. This is the surface the docs headline.
const document = bindings.createDocument({
	value: {
		children: [{ type: 'paragraph', id: 'doc-p1', content: [{ text: 'packed doc' }] }]
	},
	actor: { id: 'smoke-actor', name: 'Smoke', color: '#123456' }
});
assert.equal(document.ready, true);
assert.equal(document.readiness, 'local');
assert.equal(document.actor.id, 'smoke-actor');
// The actor is published into awareness as the durable identity + the
// display profile remote carets read.
assert.equal(document.awareness.getLocalState()?.actor?.id, 'smoke-actor');
assert.equal(document.awareness.getLocalState()?.user?.name, 'Smoke');

const [docBlock] = document.facade.project().children;
assert.equal(docBlock.id, 'doc-p1');
// Headless edit → history.undo/redo — the document's own transaction
// origin makes the edit one captured undo step.
document.transact(() => document.facade.insertText('doc-p1', 0, 'DOC>'));
assert.ok(document.facade.blockText('doc-p1').startsWith('DOC>'));
document.history.undo();
assert.equal(document.facade.blockText('doc-p1'), 'packed doc');
document.history.redo();
assert.ok(document.facade.blockText('doc-p1').startsWith('DOC>'));

// Attribution read — the actor dictionary resolves replica → actor, and
// committed edits stamp the compact per-block record (U1/U2).
assert.equal(document.attribution.actorOf(document.clientID), 'smoke-actor');
assert.equal(document.attribution.actors.get('smoke-actor')?.name, 'Smoke');
assert.equal(document.attribution.block('doc-p1')?.lastChangedBy, 'smoke-actor');

// encode → loadDocument restores the replicated state on a FRESH replica
// identity (clientID is never restored — only the state).
const saved = document.encode();
const restored = bindings.loadDocument(saved);
assert.equal(restored.ready, true);
assert.equal(restored.readiness, 'hydrated');
assert.notEqual(restored.doc.clientID, document.doc.clientID);
assert.deepEqual(restored.facade.toJSON(), document.facade.toJSON());
// Actor dictionary + block records travel inside the update — the
// restored replica resolves the original actor and block authorship.
assert.equal(restored.attribution.actors.get('smoke-actor')?.name, 'Smoke');
assert.equal(restored.attribution.block('doc-p1')?.lastChangedBy, 'smoke-actor');
restored.destroy();

// attachDocument composes the same services around a doc the CALLER owns
// — destroy() releases the document services but never doc.destroy()s the
// borrowed doc.
const borrowed = new Y.Doc();
const attached = bindings.attachDocument(borrowed);
assert.equal(attached.doc, borrowed);
assert.equal(attached.readiness, 'pending'); // attach never auto-seeds
attached.sync(); // fresh doc → seeds the canonical bootstrap block
assert.equal(attached.readiness, 'local');
assert.equal(attached.facade.project().children.length, 1);
attached.destroy();
assert.equal(attached.destroyed, true);
borrowed.destroy(); // the borrowed doc outlives its document by contract

// attachSync — an EdytorSync-shaped factory attaches to the document and
// drives its readiness transition via `synced`; the returned cleanup is
// tracked and run by document.destroy() (document-lifetime providers).
let syncCleaned = false;
const syncCleanup = document.attachSync(({ doc, awareness, synced }) => {
	assert.equal(doc, document.doc);
	assert.equal(awareness, document.awareness);
	synced(); // already-ready document → sync() is an idempotent no-op
	return () => {
		syncCleaned = true;
	};
});
assert.equal(typeof syncCleanup, 'function');
document.destroy();
assert.equal(syncCleaned, true, 'document.destroy() must run tracked sync cleanups');
assert.equal(document.destroyed, true);

// ── package encapsulation: consumers never need (and cannot take) deep ───
// paths. The exports map lists exactly '.', './crdt', './crdt/edytor',
// './protocol', './cloudflare' and the theme stylesheet.
for (const deep of [
	'edytor/dist/crdt/vendor/yjs/src/index.js',
	'edytor/crdt/vendor/yjs/src/index.js',
	'edytor/package.json'
]) {
	await assert.rejects(
		() => import(deep),
		(err) => err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
		`${deep} must not be importable — only the three public subpaths`
	);
}

// ── single engine: the v13 stack is NOT in the published dependency set ──
// Two layers of evidence: what the tarball declares, and what the install
// actually materialized (pnpm .pnpm store + npm nested layout both covered).
const { existsSync, readdirSync, readFileSync } = await import('node:fs');
const { join } = await import('node:path');

const packedPkg = JSON.parse(
	readFileSync(new URL('./node_modules/edytor/package.json', import.meta.url), 'utf8')
);
const depNames = Object.keys(packedPkg.dependencies ?? {});
const BANNED = new Set(['yjs', 'yjs-14-move', 'y-protocols', 'y-indexeddb', 'y-websocket']);
for (const banned of BANNED) {
	assert.ok(!depNames.includes(banned), `edytor dependencies must not include ${banned}`);
}
assert.ok(!depNames.includes('lib0'), 'v13 lib0 line must not be a dependency');
assert.ok(depNames.includes('lib0-v14'), 'the engine lib line is the v14 lib0 alias');

const offenders = [];
// A directory counts as an *installed package entry* only when it sits
// directly under a `node_modules` dir (npm layout / pnpm links) or is a
// `.pnpm/<name>@<ver>` store key. Package-internal dirs — e.g. the vendored
// engine at `edytor/dist/crdt/vendor/yjs` — are not installed dependencies.
const BANNED_RE = /^(yjs|yjs-14-move|y-protocols|y-indexeddb|y-websocket)$|^@y(\/|$)/;
const scan = (dir, depth = 0) => {
	if (depth > 10) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const base = dir.split('/').pop();
	const entriesArePackages = base === 'node_modules' || base === '.pnpm';
	for (const ent of entries) {
		if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
		const p = join(dir, ent.name);
		if (entriesArePackages) {
			const name = ent.name.replace('+', '/'); // pnpm encodes scope '/' as '+'
			const pkgName =
				base === '.pnpm' && name.includes('@') ? name.slice(0, name.lastIndexOf('@')) : name;
			if (BANNED_RE.test(pkgName) || pkgName.startsWith('@y/')) {
				offenders.push(p);
				continue;
			}
			if (pkgName === 'lib0') {
				// v14's lib line materializes as lib0@1.x (rc); lib0@0.x = v13.
				const pj =
					base === '.pnpm'
						? join(p, 'node_modules', 'lib0', 'package.json')
						: join(p, 'package.json');
				if (existsSync(pj)) {
					const v = JSON.parse(readFileSync(pj, 'utf8')).version;
					if (typeof v === 'string' && v.startsWith('0.')) offenders.push(p);
				}
				continue;
			}
		}
		if (ent.isDirectory() && !ent.isSymbolicLink()) scan(p, depth + 1);
	}
};
scan(new URL('./node_modules/', import.meta.url).pathname);
assert.deepEqual(
	[...new Set(offenders)],
	[],
	`v13 engine artifacts must not materialize in a packed consumer install: ${offenders}`
);

console.log('packed-consumer smoke OK — engine + public boundary work at runtime');
