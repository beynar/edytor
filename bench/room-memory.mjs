#!/usr/bin/env node
/**
 * room-memory.mjs — heap per stored byte of a room's live document
 * (production-readiness plan WU-04, `room.quota`). Dev-only; not shipped.
 *
 *   node --expose-gc bench/room-memory.mjs
 *
 * The room's document quota (`maxDocumentBytes`) measures what its records
 * hold, uncompressed: after a compaction, the v2 snapshot of the live
 * document (`encodeStateAsUpdateV2`). What the isolate holds is the live
 * engine doc that snapshot loads into, plus, once a server edit, a history,
 * a validation or a read needs it, the facade's index. This script builds
 * documents of several shapes with `createDocument`, stores them the way a
 * compaction does, loads each into a room-like doc (`keepCopies`, as
 * `prepareRoomDoc`) three times over, and reads the retained heap after a
 * full GC: once with the bare doc, once with its facade too.
 *
 * workerd exposes no heap counter (`process.memoryUsage()` and
 * `v8.getHeapStatistics()` read 0, `v8.getHeapSnapshot()` is not
 * implemented), so the numbers are Node's. Both run V8; Node's heap is
 * built without pointer compression, workerd's with it, so a Worker holds
 * the same objects in less: these ratios are an upper bound.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.gc !== 'function') {
	console.error('run with node --expose-gc');
	process.exit(1);
}

const req = createRequire(import.meta.url);
const vitestDir = req.resolve('vitest/package.json', {
	paths: [fileURLToPath(new URL('..', import.meta.url))]
});
const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
const jiti = createJiti(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const E = await jiti.import(`${root}src/lib/crdt/index.ts`);
const { Y } = await jiti.import(`${root}src/lib/crdt/engine.js`);
const crdt = E.bindCrdt(Y);
const lookups = E.facadeConfigOf(E.defaultSemantics);

const heap = () => {
	for (let i = 0; i < 4; i++) globalThis.gc();
	return process.memoryUsage().heapUsed;
};
const mb = (b) => +(b / 1048576).toFixed(2);

const words = 'the quick brown fox jumps over a lazy dog while edytor keeps every replica'.split(
	' '
);
const sentence = (i, length) => {
	let s = '';
	for (let w = i; s.length < length; w++) s += `${words[w % words.length]} `;
	return s.slice(0, length);
};

/** Document shapes: what a block holds, and how it was written. */
const SHAPES = {
	// One short line per block (a checklist, an outline): the worst case.
	short: (n) => ({
		value: {
			children: Array.from({ length: n }, (_, i) => ({
				type: 'paragraph',
				content: [{ text: sentence(i, 24) }]
			}))
		}
	}),
	// A paragraph of prose per block.
	prose: (n) => ({
		value: {
			children: Array.from({ length: n }, (_, i) => ({
				type: 'paragraph',
				content: [{ text: sentence(i, 400) }]
			}))
		}
	}),
	// Prose with a bold and an italic run per block (paired mark items).
	marked: (n) => ({
		value: {
			children: Array.from({ length: n }, (_, i) => ({
				type: 'paragraph',
				content: [
					{ text: sentence(i, 120) },
					{ text: sentence(i + 3, 40), marks: { bold: true } },
					{ text: sentence(i + 5, 120) },
					{ text: sentence(i + 7, 30), marks: { italic: true } },
					{ text: sentence(i + 9, 90) }
				]
			}))
		}
	}),
	// Typed: Enter then one transaction per word, as an editor writes it.
	typed: (n) => ({ typed: n })
};

/** The document of `shape` × `n`, as a compaction stores it (v2). */
const stored = (shape, n) => {
	const spec = SHAPES[shape](n);
	if (spec.value) {
		const document = E.createDocument({ value: spec.value, semantics: E.defaultSemantics });
		const bytes = Y.encodeStateAsUpdateV2(document.doc);
		document.destroy();
		return bytes;
	}
	const document = E.createDocument({
		value: { children: [{ id: 'b0', type: 'paragraph' }] },
		semantics: E.defaultSemantics
	});
	const f = document.facade;
	let id = 'b0';
	for (let b = 0; b < spec.typed; b++) {
		const text = sentence(b, 60);
		let at = 0;
		for (const word of text.split(/(?<= )/)) {
			document.transact(() => f.insertText(id, at, word));
			at += word.length;
		}
		if (b + 1 < spec.typed) {
			const next = `b${b + 1}`;
			document.transact(() => f.splitBlock(id, at, next));
			id = next;
		}
	}
	const bytes = Y.encodeStateAsUpdateV2(document.doc);
	document.destroy();
	return bytes;
};

/** Three room docs holding `bytes`, with (`facade`) or without their index: retained heap per doc. */
const retained = (bytes, facade) => {
	const before = heap();
	const held = [];
	for (let i = 0; i < 3; i++) {
		const doc = crdt.createDoc();
		crdt.doc.keepCopies(doc);
		Y.applyUpdateV2(doc, bytes);
		const f = facade ? crdt.doc.create(doc, lookups) : null;
		if (f) f.toJSON();
		held.push({ doc, f });
	}
	const after = heap();
	for (const { doc, f } of held) {
		f?.dispose();
		doc.destroy();
	}
	return (after - before) / 3;
};

const rows = [];
for (const [shape, sizes] of [
	['short', [1000, 2000, 5000, 10000]],
	['prose', [500, 2000, 5000]],
	['marked', [500, 2000]],
	['typed', [500, 2000]]
]) {
	for (const n of sizes) {
		const bytes = stored(shape, n);
		const doc = retained(bytes, false);
		const indexed = retained(bytes, true);
		rows.push({
			shape,
			blocks: n,
			storedKB: +(bytes.length / 1024).toFixed(1),
			docMB: mb(doc),
			withFacadeMB: mb(indexed),
			perByteDoc: +(doc / bytes.length).toFixed(1),
			perByteWithFacade: +(indexed / bytes.length).toFixed(1)
		});
		console.log(JSON.stringify(rows.at(-1)));
	}
}
console.table(rows);
