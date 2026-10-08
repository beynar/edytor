#!/usr/bin/env node
/**
 * What a soak client's heap is made of (WU-16 follow-up). Dev-only.
 *
 *   node --expose-gc bench/soak/heap.mjs [--replicas 16] [--edits 6000]
 *     [--seed 1] [--doc update.bin] [--snapshot]
 *
 * Builds a soak document in memory (`size.mjs`'s `generate`: `--edits` of
 * the soak's mix by `--replicas` writers), or reads one (`--doc`, a v1
 * update), then measures the heap one replica holding it takes, after a
 * full collection, layer by layer:
 *
 * - the engine's document alone (`crdt.createDoc()` + the update): its
 *   structs, their ids and contents, the types' maps;
 * - a bare facade over it, its index folded (`crdt.doc.create`);
 * - a document as a soak client holds one (`createDocument`, synced: the
 *   facade, its index, its undo history).
 *
 * `--snapshot` also writes a heap snapshot before and after the load and
 * prints the difference by constructor (the most costly first).
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import { loadEngine } from './engine.mjs';
import { generate } from './size.mjs';

if (typeof gc !== 'function') {
	console.error('run with node --expose-gc');
	process.exit(2);
}
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	if (at === -1) return fallback;
	return typeof fallback === 'number' ? Number(args[at + 1]) : args[at + 1];
};
const engine = await loadEngine();
const { E, Y, crdt } = engine;
let update;
if (option('doc', '')) update = new Uint8Array(readFileSync(option('doc', '')));
else {
	const { document, documents } = generate(engine, {
		replicas: option('replicas', 16),
		edits: option('edits', 6000),
		seed: option('seed', 1)
	});
	update = document.encode();
	for (const d of documents) d.destroy();
}
const REMOTE = Symbol('soak-heap-remote');
const MB = 1048576;
const heap = () => {
	gc();
	return process.memoryUsage().heapUsed;
};
/** The heap `make` keeps, after a full collection. */
const measure = (make) => {
	const before = heap();
	const held = make();
	return { held, bytes: heap() - before };
};
const stored = (() => {
	const doc = crdt.createDoc();
	Y.applyUpdate(doc, update, REMOTE);
	const out = { v2: Y.encodeStateAsUpdateV2(doc).length, structs: 0 };
	for (const structs of doc.store.clients.values()) out.structs += structs.length;
	doc.destroy();
	return out;
})();
const raw = measure(() => {
	const doc = crdt.createDoc();
	Y.applyUpdate(doc, update, REMOTE);
	return doc;
});
const facade = measure(() => {
	const f = crdt.doc.create(raw.held);
	f.toJSON();
	return f;
});
facade.held.dispose();
raw.held.destroy();

/** A heap snapshot's self sizes by constructor (strings, arrays, code as their own rows). */
const census = () => {
	const path = join(tmpdir(), `soak-heap-${process.pid}.heapsnapshot`);
	v8.writeHeapSnapshot(path);
	const s = JSON.parse(readFileSync(path, 'utf8'));
	unlinkSync(path);
	const fields = s.snapshot.meta.node_fields;
	const types = s.snapshot.meta.node_types[0];
	const [type, name, size] = ['type', 'name', 'self_size'].map((f) => fields.indexOf(f));
	const by = new Map();
	for (let i = 0; i < s.nodes.length; i += fields.length) {
		const kind = types[s.nodes[i + type]];
		const key = kind === 'object' ? s.strings[s.nodes[i + name]] : `(${kind})`;
		const row = by.get(key) ?? { count: 0, bytes: 0 };
		row.count++;
		row.bytes += s.nodes[i + size];
		by.set(key, row);
	}
	return by;
};
const snapshot = args.includes('--snapshot');
const client = E.createDocument({ actor: { id: 'probe' }, semantics: E.defaultSemantics });
client.facade.toJSON();
const before = snapshot ? census() : null;
const synced = measure(() => {
	Y.applyUpdate(client.doc, update, REMOTE);
	client.facade.toJSON();
	return client;
});
const report = {
	stored: stored.v2,
	structs: stored.structs,
	engineMB: raw.bytes / MB,
	indexMB: facade.bytes / MB,
	documentMB: synced.bytes / MB,
	heapPerStoredByte: Math.round((synced.bytes / stored.v2) * 10) / 10,
	enginePerStruct: Math.round(raw.bytes / stored.structs)
};
console.log(JSON.stringify(report, null, 2));
if (before) {
	const after = census();
	const rows = [...after]
		.map(([key, r]) => [
			key,
			r.count - (before.get(key)?.count ?? 0),
			r.bytes - (before.get(key)?.bytes ?? 0)
		])
		.sort((a, b) => b[2] - a[2])
		.slice(0, 20);
	for (const [key, count, bytes] of rows)
		console.log(`${(bytes / MB).toFixed(2).padStart(7)} MB ${String(count).padStart(8)}  ${key}`);
}
client.destroy();
