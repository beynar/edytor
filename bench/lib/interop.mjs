#!/usr/bin/env node
/**
 * WU9/P4 interop check — patched vendored engine vs git-HEAD baseline engine.
 *
 * The two engines are separate module instances (different class identities):
 * they can only interact through the wire protocol (encodeStateAsUpdate /
 * applyUpdate), exactly like a patched client syncing with an unpatched
 * deployment. Asserts convergent rendered state (delta JSON), convergent
 * store stats, and stable relative-position resolution across edits, undo,
 * GC-triggering deletes and bidirectional sync.
 *
 * Run:  bench/lib/mk-baseline.sh && node bench/lib/interop.mjs
 */
import * as YPatched from '../../src/lib/crdt/vendor/yjs/src/index.js';
import * as YBaseline from '../vendor-baseline/yjs/index.js';
import * as delta from 'lib0-v14/delta';

let failures = 0;
const check = (name, cond, extra = '') => {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name} ${extra}`);
	}
};

const normDelta = (text) => JSON.stringify(text.toDelta().toJSON());

const fragmented = (Y, doc, n) => {
	const t = doc.get('t');
	doc.transact(() => {
		const d = delta.create();
		for (let i = 0; i < n; i++) d.insert('x', i % 2 ? { i: true } : { b: true });
		t.applyDelta(d);
	});
	return t;
};

const sync = (a, b) => {
	// state-vector-diffed update exchange, both directions
	const ua = YPatched.encodeStateAsUpdate(a, YBaseline.encodeStateVector(b));
	const ub = YBaseline.encodeStateAsUpdate(b, YPatched.encodeStateVector(a));
	YPatched.applyUpdate(a, ub);
	YBaseline.applyUpdate(b, ua);
};

console.log('== interop: baseline -> patched bootstrap ==');
const A = new YPatched.Doc(); // patched peer
const B = new YBaseline.Doc(); // baseline peer
const tB = fragmented(YBaseline, B, 400);
sync(A, B);
const tA = A.get('t');
check('bootstrap delta identical', normDelta(tA) === normDelta(tB));

console.log('== alternating distant edits both directions ==');
// distant edits on each side; a marker-seeded applyDelta on A vs upstream walk on B
const positions = [10, 380, 120, 350, 60, 200, 390, 30];
for (let i = 0; i < positions.length; i++) {
	const p = positions[i];
	if (i % 2 === 0) {
		A.transact(() => tA.applyDelta(delta.create().retain(p).insert(`A${i}`, { u: true })));
	} else {
		B.transact(() => tB.applyDelta(delta.create().retain(p).insert(`B${i}`)));
	}
}
sync(A, B);
check('after 8 cross edits: delta identical', normDelta(tA) === normDelta(tB));
check('lengths equal', tA.length === tB.length, `${tA.length} vs ${tB.length}`);

console.log('== format ops crossing a seeded region ==');
A.transact(() => tA.applyDelta(delta.create().retain(100).retain(50, { b: null, hl: true })));
B.transact(() => tB.applyDelta(delta.create().retain(90).retain(20, { i: null })));
sync(A, B);
check('after format ops: delta identical', normDelta(tA) === normDelta(tB));

console.log('== relative-position anchors across peers ==');
// anchor created on baseline resolves identically on patched
const relpos = YBaseline.createRelativePositionFromTypeIndex(tB, 150, 0);
const rjson = YBaseline.relativePositionToJSON(relpos);
const onA = YPatched.createAbsolutePositionFromRelativePosition(
	YPatched.createRelativePositionFromJSON(rjson),
	A,
	false
);
const onB = YBaseline.createAbsolutePositionFromRelativePosition(relpos, B, false);
check('anchor resolves same index', onA?.index === onB?.index, `${onA?.index} vs ${onB?.index}`);

console.log('== deletes + GC ==');
B.transact(() => tB.applyDelta(delta.create().retain(50).delete(150)));
A.transact(() => tA.applyDelta(delta.create().retain(10).delete(30)));
sync(A, B);
// force a GC-eligible transaction round
A.transact(() => {});
B.transact(() => {});
check('after deletes: delta identical', normDelta(tA) === normDelta(tB));
check('after deletes: lengths equal', tA.length === tB.length);

console.log('== undo on patched side, synced to baseline ==');
const um = new YPatched.UndoManager(tA, { trackedOrigins: new Set([A]) });
A.transact(() => tA.applyDelta(delta.create().retain(5).insert('UNDO-ME', { b: true })), A);
sync(A, B);
check('pre-undo delta identical', normDelta(tA) === normDelta(tB));
um.undo();
sync(A, B);
check('post-undo delta identical', normDelta(tA) === normDelta(tB));

console.log('== concurrent edits (conflict) ==');
A.transact(() => tA.applyDelta(delta.create().retain(100).insert('A-concurrent', { b: true })));
B.transact(() => tB.applyDelta(delta.create().retain(100).insert('B-concurrent', { i: true })));
sync(A, B);
sync(A, B); // second round in case first produced new diffs
check('concurrent: delta identical', normDelta(tA) === normDelta(tB));
check('concurrent: lengths equal', tA.length === tB.length, `${tA.length} vs ${tB.length}`);

console.log('== store-size sanity ==');
const structsA = [...A.store.clients.values()].reduce((n, arr) => n + arr.length, 0);
const structsB = [...B.store.clients.values()].reduce((n, arr) => n + arr.length, 0);
check('struct counts equal', structsA === structsB, `${structsA} vs ${structsB}`);

console.log(failures === 0 ? '\nINTEROP: all checks passed' : `\nINTEROP: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
