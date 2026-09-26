/**
 * memory-probe.mjs — WU9 leak-vs-snapshot split for the
 * `post-edit-undo-lifecycle` retained-heap lane (baseline.js `memory()`).
 *
 * Replicates the lane's exact sequence — snap/restore fixture discipline,
 * the 100/1k/5k held-doc loop, then the 200-edit undo churn — but adds
 * stage decomposition and a full-teardown phase the lane lacks. The lane's
 * +120 MB is measured while {doc, ed, um} are still live; the question is
 * what survives teardown and whether it grows per cycle.
 *
 * Run:  node --expose-gc bench/lib/memory-probe.mjs
 */
import * as Y14 from '../../src/lib/crdt/vendor/yjs/src/index.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
const vitestDir = req.resolve('vitest/package.json', {
	paths: [fileURLToPath(new URL('../..', import.meta.url))]
});
const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
const jiti = createJiti(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const { bindEdytorDoc } = await jiti.import(`${here}../../src/lib/crdt/edytor-doc.ts`);
const E = bindEdytorDoc(Y14);

const heap = () => {
	globalThis.gc();
	globalThis.gc();
	return process.memoryUsage().heapUsed;
};
const mb = (b) => +(b / 1048576).toFixed(1);

const flatSpec = (n, chars = 60) => ({
	content: Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ kind: 'text', text: `block-${i} ` + 'x'.repeat(chars) }]
	}))
});

const flatDoc = (n, chars) => {
	const doc = new Y14.Doc();
	E.init(doc, flatSpec(n, chars));
	const ed = E.create(doc);
	return { doc, ed, targetId: `b${Math.floor(n / 2)}` };
};

const snap = (built) => {
	const snapshot = Y14.encodeStateAsUpdate(built.doc);
	built.doc.destroy();
	return {
		snapshot,
		restore: () => {
			const doc = new Y14.Doc();
			Y14.applyUpdate(doc, snapshot);
			return { doc, ed: E.create(doc) };
		}
	};
};

const registry = new FinalizationRegistry((name) => registry.collected.push(name));
registry.collected = [];

// ── phase 1: replicate the lane's held-doc loop ───────────────────────────
const base = heap();
const laneHeaps = {};
for (const n of [100, 1000, 5000]) {
	const f = snap(flatDoc(n));
	const docs = [];
	for (let i = 0; i < 3; i++) docs.push(f.restore());
	const withDocs = heap();
	laneHeaps[`retained-${n}`] = mb(withDocs - base);
	for (const d of docs) d.doc.destroy();
}
const postLoop = heap();

// ── phase 2: the lifecycle, held (what the lane measures) ─────────────────
const hold = snap(flatDoc(1000)).restore();
const built = heap();
hold.um = new Y14.UndoManager(hold.doc.get('blocks'), { captureTimeout: 0 });
for (let k = 0; k < 200; k++) {
	hold.ed.insertText('b500', 10, 'q');
	if (k % 2) hold.um.undo();
}
const churn = heap(); // ← the lane's +120 MB sample point
registry.register(hold.doc, 'lifecycle:doc');
registry.register(hold.ed, 'lifecycle:ed');

// ── phase 3: staged teardown ──────────────────────────────────────────────
hold.um.destroy();
const noUm = heap();
hold.ed.dispose();
const noEd = heap();
hold.doc.destroy();
const destroyed = heap(); // doc/ed/um unreachable — conservative-stack refs may linger
const settle = heap(); //  a second measurement after returning from the churn frame

// ── phase 4: a SECOND full lifecycle — per-cycle growth = real leak ───────
const c2 = snap(flatDoc(1000)).restore();
c2.um = new Y14.UndoManager(c2.doc.get('blocks'), { captureTimeout: 0 });
for (let k = 0; k < 200; k++) {
	c2.ed.insertText('b500', 10, 'q');
	if (k % 2) c2.um.undo();
}
c2.um.destroy();
c2.ed.dispose();
c2.doc.destroy();
const afterCycle2 = heap();

console.log(
	JSON.stringify(
		{
			baselineHeapMB: mb(base),
			heldDocsMB: laneHeaps,
			postHeldDocLoopMB: mb(postLoop - base),
			lifecycle: {
				builtMB: mb(built - base),
				postChurnMB: mb(churn - base),
				churnAddsMB: mb(churn - built),
				postUmDestroyMB: mb(noUm - base),
				postEdDisposeMB: mb(noEd - base),
				postDocDestroyMB: mb(destroyed - base),
				settleMB: mb(settle - base)
			},
			residualAfterCycle2MB: mb(afterCycle2 - base),
			finalized: registry.collected
		},
		null,
		2
	)
);
