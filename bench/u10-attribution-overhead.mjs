#!/usr/bin/env node
/**
 * U10 qualification evidence — attribution-on vs attribution-off costs.
 * Dev-only; not shipped. Run:
 *
 *   node --expose-gc bench/u10-attribution-overhead.mjs
 *
 * Post-U2: there is no per-edit attribution capture anymore. The ON lane
 * is the integrated document (`loadDocument` + `document.transact(
 * insertText)`) — facade + history + awareness + the U1 block-attribution
 * stamps (`b/<id>` record + `l` lastChangedBy) written INSIDE the edit
 * transaction. The honest OFF lane is the bare facade (`E.create` +
 * `ed.insertText`) — the same path the recorded 0.097/0.408/1.026ms
 * keystroke baselines measured. Expect ~1 update event per commit on BOTH
 * lanes — U2 removed the attribution follow-up transaction.
 *
 * Lanes:
 *   1. keystroke p50 — one-char insert into the same paragraph while the
 *      doc scales 100 / 1,000 / 5,000 flat blocks. Methodology mirrors
 *      bench/lib/baseline.js `lane`: ONE seed doc, its state snapshotted,
 *      every sample restores a FRESH doc from the encoded update
 *      (data-cold; identical shape for both lanes — the OFF lane applies
 *      the same bytes and wraps them in a bare facade).
 *   2. fixed 200 single-char-commit workload (same shape as
 *      src/tests/crdt/attribution/overhead.test.ts):
 *      - doc.encode() byte size
 *      - update-stream bytes (Σ doc 'update' payloads) + event count
 *      - IndexedDB `updates` row growth + stored bytes (fake-indexeddb,
 *        provider writes one row per update event; <500 rows ⇒ no
 *        compaction)
 */
import 'fake-indexeddb/auto';
import * as Y14 from '../src/lib/crdt/vendor/yjs/src/index.js';
import * as idb from 'lib0-v14/indexeddb';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
const vitestDir = req.resolve('vitest/package.json').replace(/\/package\.json$/, '');
const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
const jiti = createJiti(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));

const { bindEdytorDoc } = await jiti.import(`${here}../src/lib/crdt/edytor-doc.ts`);
const { bindDocument } = await jiti.import(`${here}../src/lib/crdt/document.ts`);
const { bindIndexeddbProvider } = await jiti.import(
	`${here}../src/lib/crdt/providers/indexeddb.ts`
);
const { generationDbName } = await jiti.import(`${here}../src/lib/crdt/protocols/envelope.ts`);

const E = bindEdytorDoc(Y14);
const D = bindDocument(Y14);
const P = bindIndexeddbProvider(Y14);

const alice = { id: 'alice', name: 'Alice' };
const textOf = (chars) => 'x'.repeat(chars);
const caret = (i) => 5 + (i % 20);

const flatValue = (n, chars = 60) => ({
	children: Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `block-${i} ` + textOf(Math.max(1, chars - 7)) }]
	}))
});

const statsOf = (arr) => {
	const s = [...arr].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
	return {
		n: arr.length,
		p50: +q(50).toFixed(4),
		p95: +q(95).toFixed(4),
		mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)
	};
};

// ── lane 1: keystroke p50 — data-cold restores, identical bytes ───────────

const keystroke = (n, samples, warmup) => {
	const value = flatValue(n);
	const targetId = `b${Math.floor(n / 2)}`;
	// Seed through the document path so BOTH lanes restore byte-identical
	// state (schema + attribution root included in the snapshot).
	const seed = D.createDocument({ value, actor: alice });
	const snapshot = seed.encode();
	seed.destroy();

	const restoreOff = () => {
		const doc = new Y14.Doc();
		Y14.applyUpdate(doc, snapshot);
		return { doc, ed: E.create(doc) };
	};
	const restoreOn = () => D.loadDocument(snapshot, { actor: alice });

	const off = [];
	for (let i = 0; i < warmup + samples; i++) {
		const { doc, ed } = restoreOff();
		const t0 = performance.now();
		ed.insertText(targetId, caret(i), 'x');
		const ms = performance.now() - t0;
		doc.destroy();
		if (i >= warmup) off.push(ms);
	}
	const on = [];
	for (let i = 0; i < warmup + samples; i++) {
		const document = restoreOn();
		const t0 = performance.now();
		document.transact(() => document.facade.insertText(targetId, caret(i), 'x'));
		const ms = performance.now() - t0;
		document.destroy();
		if (i >= warmup) on.push(ms);
	}
	return { off: statsOf(off), on: statsOf(on) };
};

console.log('── keystroke p50 (one-char insert, same paragraph; data-cold restores) ──');
for (const n of [100, 1000, 5000]) {
	const samples = n >= 5000 ? 15 : 30;
	const d = keystroke(n, samples, n >= 5000 ? 2 : 3);
	console.log(
		`  ${n} blocks: facade-only p50 ${d.off.p50}ms (p95 ${d.off.p95}) · ` +
			`document+attribution p50 ${d.on.p50}ms (p95 ${d.on.p95}) · ` +
			`Δ ${(d.on.p50 - d.off.p50).toFixed(4)}ms (+${(((d.on.p50 - d.off.p50) / d.off.p50) * 100).toFixed(1)}%)`
	);
}

// ── lane 2: fixed 200-commit workload — encode/update-stream/IDB ──────────

const COMMITS = 200;

const runWorkload = async (withAttribution, dbName) => {
	let doc, document, insert;
	if (withAttribution) {
		document = D.createDocument({
			value: { children: [{ id: 'b0', type: 'paragraph', content: [{ text: 'x' }] }] },
			actor: alice
		});
		doc = document.doc;
		const block = document.facade.project().children[0];
		insert = (i) => document.transact(() => document.facade.insertText(block.id, 1 + i, 'a'));
	} else {
		doc = new Y14.Doc();
		E.init(doc, {
			content: [{ id: 'b0', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }]
		});
		const ed = E.create(doc);
		const block = ed.project().children[0];
		insert = (i) => ed.insertText(block.id, 1 + i, 'a');
	}

	let updateEvents = 0;
	let updateBytes = 0;
	doc.on('update', (u) => {
		updateEvents++;
		updateBytes += u.byteLength;
	});

	const persistence = new P.IndexeddbPersistence(dbName, doc);
	await persistence.whenSynced;
	for (let i = 0; i < COMMITS; i++) insert(i);
	await new Promise((r) => setTimeout(r, 300)); // let IDB writes settle
	const encodeBytes = (document ? document.encode() : Y14.encodeStateAsUpdate(doc)).byteLength;
	// U2 cross-check: zero legacy `a/` records + the compact block
	// attribution footprint (b/ record key+value on `blockattr`, `l` attr
	// on the block node). The retired U6 metrics were ~30.7B/record and
	// ~827B merged for 200 commits — both should now read ~0.
	let recordBytes = 0;
	let recordCount = 0;
	let blockAttrKeys = 0;
	let legacyPresent = false;
	if (withAttribution) {
		const root = doc.get('attribution');
		for (const key of root.attrKeys()) {
			const v = root.getAttr(key);
			if (key.startsWith('a/') && v instanceof Uint8Array) {
				recordBytes += v.byteLength;
				recordCount++;
			}
		}
		for (const key of doc.get('blockattr').attrKeys()) blockAttrKeys++;
		legacyPresent = document.attribution.legacy() !== null;
	}
	await persistence.destroy();
	document?.destroy();
	if (!withAttribution) doc.destroy();

	// Row growth + stored bytes in the `updates` store — the provider opens
	// the generation-prefixed database (`edytor-v14:<name>`).
	const db = await idb.openDB(generationDbName(dbName), (d) =>
		idb.createStores(d, [['updates', { autoIncrement: true }], ['custom']])
	);
	const [updatesStore] = idb.transact(db, ['updates'], 'readonly');
	const rows = await idb.getAll(updatesStore);
	const rowBytes = rows.reduce((a, r) => a + (r?.byteLength ?? r?.length ?? 0), 0);
	indexedDB.deleteDatabase(generationDbName(dbName));
	return {
		updateEvents,
		updateBytes,
		encodeBytes,
		rows: rows.length,
		rowBytes,
		recordBytes,
		recordCount,
		blockAttrKeys,
		legacyPresent
	};
};

console.log('── 200 single-char commits — compression / write amplification ──');
const t0 = Date.now();
const on = await runWorkload(true, `u10-attr-on-${t0}`);
const off = await runWorkload(false, `u10-attr-off-${t0}`);
console.log(
	`  attribution ON : encode=${on.encodeBytes}B · update stream ${on.updateBytes}B/` +
		`${on.updateEvents} events · IDB rows ${on.rows} (${on.rowBytes}B stored)`
);
console.log(
	`  U2 cross-check: a/ records=${on.recordCount} (${on.recordBytes}B), ` +
		`blockattr records=${on.blockAttrKeys}, legacy()=${on.legacyPresent}`
);
console.log(
	`  attribution OFF: encode=${off.encodeBytes}B · update stream ${off.updateBytes}B/` +
		`${off.updateEvents} events · IDB rows ${off.rows} (${off.rowBytes}B stored)`
);
console.log(
	`  Δ: encode ${(on.encodeBytes / off.encodeBytes).toFixed(2)}× · ` +
		`stream ${(on.updateBytes / off.updateBytes).toFixed(2)}× · ` +
		`rows ${(on.rows / off.rows).toFixed(2)}×`
);
