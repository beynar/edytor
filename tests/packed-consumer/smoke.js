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
assert.equal(typeof bindings.bindEdytorDoc, 'function');
assert.equal(typeof bindings.Awareness, 'function');
assert.equal(typeof bindings.bindMigration, 'function');
assert.equal(typeof bindings.bindProviders, 'function');

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

// ── the real consumer story (U12/PK01) ───────────────────────────────────
// Doc + Awareness via public exports → bindEdytorDoc facade → init →
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
assert.equal(edB.schemaVersion(), 1);
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

// ── package encapsulation: consumers never need (and cannot take) deep ───
// paths. The exports map lists exactly '.', './crdt', './crdt/edytor'.
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
