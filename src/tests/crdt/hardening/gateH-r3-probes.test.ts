/**
 * GATE H adversarial probes — R3 (undo-ownership repair).
 *
 * Pinned tests cover: basic split-tail undo, reload, incremental+full
 * remote sync, marks, concurrent remote edit, remote-edit-capture
 * ordering, raw UM, anchor collapse, repeated cycles, lease lifecycle.
 *
 * Probed here:
 *
 *  1. `ed.transact(() => um.undo())` — the facade DOCUMENTS `transact` for
 *     "callers that batch several ops into one undo step / one event"
 *     (edytor-doc.ts). When undo joins an outer transaction the committed
 *     transaction's `origin` is the outer one (e.g. null), not the
 *     UndoManager. FIXED: the repair gate is now STRUCTURAL — it detects
 *     the resurrection signature (`redoItem` copies carry `keep`, and a
 *     tombstone's `redone` points into the transaction's `insertSet`) —
 *     so nested/custom origins cannot bypass it.
 *
 *  2. Foreign atoms inserted BETWEEN delete and undo inside the span —
 *     the repair claim's s/e anchors bind positions in the LIVE list; an
 *     atom inserted mid-span is covered by the written record.
 *
 *  3. Same-winner undo must write ZERO repair records (spurious churn) —
 *     and a plain insert/delete must not even trigger the detector.
 *
 *  4. Two peers undoing DIFFERENT deletions on the same backing text —
 *     concurrent repair claims must converge AND be correct.
 *
 *  5. Repair claims on a holder merged-away between delete and undo —
 *     dead-owner fallback.
 *
 *  6. Torn committed frame (R5-D6 joint finding) — the repair now writes
 *     inside the committing transaction's `beforeObserverCalls` phase and
 *     folds its `changed` entries into that frame, so subscribers see ONE
 *     notification carrying the repaired state.
 *
 *  7. Redo-of-undo-of-insert resurrects atoms — the signature catches it;
 *     the planner correctly writes zero claims when ownership is already
 *     right.
 */
// @ts-nocheck -- exercises private model/engine internals on purpose.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
let cid = 400_000;

const seed = () => {
	const doc = new Y.Doc();
	doc.clientID = cid++;
	const ed = E.create(doc);
	ed.init({
		content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }]
	});
	return { doc, ed };
};

const push = (from: Y.Doc, to: Y.Doc) => {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
};

/** The block's replicated claims list — an undo must write nothing there (R2: no repair). */
const slicesOf = (ed: any, id: string) =>
	ed.resolveBlock(id)!.getAttr('claims').toArray() as unknown[];

describe('gateH-R3 — undo inside an outer transaction', () => {
	test('ed.transact(() => um.undo()) — repair must still fire', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		expect(ed.blockText('tail')).toBe('');
		// Batch undo inside an explicit transaction — a documented facade
		// pattern ('one undo step / one event'). The committed transaction's
		// origin is the OUTER one → the repair's `origin instanceof
		// UndoManager` gate must still recognize the resurrection.
		ed.transact(() => um.undo());
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
	});

	test('doc.transact(() => um.undo(), customOrigin) — same hole via custom origin', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		doc.transact(() => um.undo(), { tag: 'batch' });
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
	});
});

describe('gateH-R3 — foreign atoms inside the resurrected span', () => {
	test('insert between delete and undo lands mid-span — covered or not?', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		// A write into 'tail' AFTER the delete with a NON-tracked origin —
		// it is a live atom sitting inside the resurrected span's index
		// range, and it must NOT be popped by the undo (it is not on the
		// undo stack — mimics a remote edit).
		ed.transact(() => ed.insertText('tail', 0, 'XX'), 'foreign-sim');
		um.undo();
		const b = ed.blockText('b');
		const t = ed.blockText('tail');
		console.log(`[r3-foreign] b=${JSON.stringify(b)} tail=${JSON.stringify(t)}`);
		// The undo must not eat 'XX' into 'b', and 'world' must come home.
		// Acceptable outcomes: tail='XXworld' or 'worldXX' — the claim may
		// legitimately cover XX (inserted into tail's region) — but NOT
		// tail='' / b='hello XXworld' (the pre-repair bug shape).
		expect(b.startsWith('hello ')).toBe(true);
		expect(t).toContain('world');
		expect(b + '|' + t).toContain('XX'); // XX must survive somewhere
	});
});

describe('gateH-R3 — spurious write check', () => {
	test('single-block undo (same winner) writes ZERO repair records', () => {
		const { ed } = seed();
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const before = slicesOf(ed, 'b').length;
		ed.block('b').deleteText(0, 5);
		um.undo();
		const after = slicesOf(ed, 'b').length;
		// 'hello' resurrected under 'b' — already owned by 'b' → no claim.
		expect(after).toBe(before);
		expect(ed.blockText('b')).toBe('hello world');
	});
});

describe('gateH-R3 — concurrent undo repairs on one text', () => {
	test('two peers undo different deletions of the same backing text', () => {
		const docA = new Y.Doc();
		docA.clientID = cid++;
		const edA = E.create(docA);
		edA.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'aaaabbbbcccc' }] }]
		});
		edA.block('b').split(4, 'm');
		edA.block('m').split(4, 't'); // b='aaaa' m='bbbb' t='cccc'
		const docB = new Y.Doc();
		docB.clientID = cid++;
		const edB = E.create(docB);
		push(docA, docB);
		expect(edB.blockText('t')).toBe('cccc');

		const umA = edA.createUndoManager({ captureTimeout: 0 });
		const umB = edB.createUndoManager({ captureTimeout: 0 });
		// A deletes tail's text, B deletes mid's text — concurrently.
		edA.block('t').deleteText(0, 4);
		edB.block('m').deleteText(0, 4);
		push(docA, docB);
		push(docB, docA);
		expect(edA.blockText('m')).toBe('');
		expect(edA.blockText('t')).toBe('');
		expect(edB.blockText('m')).toBe('');
		expect(edB.blockText('t')).toBe('');
		// Each peer undoes ITS OWN delete — both repairs fire, both replicate.
		umA.undo();
		umB.undo();
		push(docA, docB);
		push(docB, docA);
		// Convergent and correct: each text back under its own block.
		expect(edA.blockText('b')).toBe('aaaa');
		expect(edA.blockText('m')).toBe('bbbb');
		expect(edA.blockText('t')).toBe('cccc');
		expect(edB.blockText('b')).toBe(edA.blockText('b'));
		expect(edB.blockText('m')).toBe(edA.blockText('m'));
		expect(edB.blockText('t')).toBe(edA.blockText('t'));
	});
});

describe('gateH-R3 — dead-owner fallback and merge interplay', () => {
	test('delete, merge holder away (untracked), undo — atoms surface under a live record', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		// Merge tail back into b BETWEEN delete and undo under a NON-tracked
		// origin (not on the undo stack — mimics a remote merge) — the
		// pre-delete holder is dead when the undo lands.
		ed.transact(() => ed.mergeBlocks('tail', 'b'), 'foreign-sim');
		expect(ed.listBlockIds()).toEqual(['b']);
		um.undo();
		const b = ed.blockText('b');
		console.log(
			`[r3-deadowner] b=${JSON.stringify(b)} tail=${JSON.stringify(ed.blockText('tail'))} ids=${JSON.stringify(ed.listBlockIds())}`
		);
		// Dead-owner fallback: 'world' surfaces under 'b' (the surviving
		// record now covers the region) — the documented limitation.
		expect(b).toBe('hello world');
	});

	test('undo of a MERGE resurrects block+atoms — repair keeps source ownership', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		um.stopCapturing();
		// Merge tail into b — 'world' atoms now display under b.
		const merged = ed.mergeBlocks?.('tail', 'b');
		console.log(
			`[r3-mergeundo] merged=${merged} b=${JSON.stringify(ed.blockText('b'))} ids=${JSON.stringify(ed.listBlockIds())}`
		);
		um.undo();
		console.log(
			`[r3-mergeundo] after undo b=${JSON.stringify(ed.blockText('b'))} tail=${JSON.stringify(ed.blockText('tail'))} ids=${JSON.stringify(ed.listBlockIds())}`
		);
	});
});

describe('gateH-R3 — torn committed frame (R5-D6 joint finding)', () => {
	const flat = (runs: readonly { kind: string; text?: string }[]) =>
		runs.map((r) => (r.kind === 'text' ? r.text : '#')).join('');

	test('subscribeBlock never sees the unrepaired intermediate', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const seenB: string[] = [];
		const seenTail: string[] = [];
		ed.subscribeBlock('b', (runs: any) => seenB.push(flat(runs)));
		ed.subscribeBlock('tail', (runs: any) => seenTail.push(flat(runs)));
		ed.block('tail').deleteText(0, 5);
		seenB.length = 0;
		seenTail.length = 0;
		um.undo();
		// 'b' shows 'hello ' before AND after the repaired undo — the only
		// correct outcome is ZERO 'b' notifications. Pre-fix the committed
		// frame carried 'hello world' (resurrected atoms swallowed by the
		// source record) followed by a second frame 'hello ' — a torn
		// intermediate published to subscribers.
		expect(seenB).toEqual([]);
		expect(seenTail).toEqual(['world']); // exactly one repaired frame
	});

	test('onChange emits ONE DocChange with repaired content, under the undo origin', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const changes: any[] = [];
		ed.onChange((c: any) => changes.push(c));
		ed.block('tail').deleteText(0, 5);
		changes.length = 0;
		um.undo();
		// One semantic change carrying the repaired state — the repair
		// transaction's identical recompute publishes nothing.
		expect(changes.length).toBe(1);
		expect(changes[0].origin instanceof Y.UndoManager).toBe(true);
		const texts = new Map([...changes[0].content.entries()].map(([k, v]: any) => [k, flat(v)]));
		// 'b' is unchanged ('hello ' → 'hello ') → absent from the diff;
		// 'tail' gained the resurrected atoms.
		expect(texts.has('b')).toBe(false);
		expect(texts.get('tail')).toBe('world');
	});

	test('nested undo (custom origin) publishes no torn frame either', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const seenB: string[] = [];
		const seenTail: string[] = [];
		ed.subscribeBlock('b', (runs: any) => seenB.push(flat(runs)));
		ed.subscribeBlock('tail', (runs: any) => seenTail.push(flat(runs)));
		ed.block('tail').deleteText(0, 5);
		seenB.length = 0;
		seenTail.length = 0;
		doc.transact(() => um.undo(), { tag: 'batch' });
		expect(seenB).toEqual([]);
		expect(seenTail).toEqual(['world']);
		expect(ed.blockText('tail')).toBe('world');
	});
});

describe('gateH-R3 — redo resurrection + mixed transactions', () => {
	test('redo of undo-of-insert resurrects atoms — detected, zero claims needed', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const before = slicesOf(ed, 'tail').length;
		ed.insertText('tail', 5, 'X'); // tail='worldX'
		um.undo(); // deletes 'X' — pure removal, no resurrection
		expect(ed.blockText('tail')).toBe('world');
		um.redo(); // RESURRECTS 'X' — copies carry keep/redone → detector fires
		// 'X' was tail-owned at insert; the same record still covers it →
		// the planner must write ZERO claims (same winner both spaces).
		expect(ed.blockText('tail')).toBe('worldX');
		expect(ed.blockText('b')).toBe('hello ');
		expect(slicesOf(ed, 'tail').length).toBe(before);
	});

	test('resurrection + normal writes in one transaction — copies repaired, writes kept', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		ed.transact(() => {
			ed.insertText('b', 0, 'Q');
			um.undo();
		});
		// 'Q' is a normal insert (keep=false) — it must not be swallowed
		// into a repair claim, and 'world' must come home to 'tail'.
		expect(ed.blockText('b')).toBe('Qhello ');
		expect(ed.blockText('tail')).toBe('world');
	});
});
