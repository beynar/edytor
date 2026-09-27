/**
 * HARDENING U0 / R3 — undo restores deleted text into the WRONG paragraph
 * (review `docs/crdt-v14-follow-up-review-2026-09-21.md` §R3, P1).
 *
 * After `b` = "hello world" is split at 6 into `b`="hello " + `tail`="world",
 * deleting `tail`'s five chars and undoing must restore them to `tail`.
 * Instead the resurrected atoms are re-attributed to the ORIGINAL owner `b`:
 * `b`="hello world", `tail`="". Ownership is stored per item; the undo
 * restore path does not reproduce the split-time attribution.
 *
 * Reproduction (all verified against this tree):
 *
 *   b = 'hello world';  b.split(6,'tail');
 *   um = createUndoManager({ captureTimeout: 0 });
 *   tail.deleteText(0,5);  um.undo();
 *
 * OBSERVED pre-repair (vitest run, this file):
 *   basic:              b='hello world'  tail=''        (expected 'hello '/'world')
 *   marks:              b runs [plain 'hello ', bold 'world'], tail runs []
 *   remote (incremental + fresh apply): same wrong ownership
 *   concurrent remote edit on b:       b='hello !world', tail=''
 *   binary save → reload:              wrongness persists byte-for-byte
 *
 * U3 fixed this with a doc-level undo-ownership repair (a follow-up slice
 * claim over the copies). Since arch-v2 D12 there is no repair: a stream is
 * delimited by boundary items placed at the end of the gap (P7), and the
 * engine's `redoItem` integrates each copy between its tombstone's left
 * neighbour and the tombstone — inside the stream that displayed it (R2).
 * `wu6-delete-range.test.ts` was amended in the same unit: it previously
 * expected the redistributed ownership ('early'='' after undo), i.e. it
 * blessed this defect.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
let cid = 300_000;

const seed = () => {
	const doc = new Y.Doc();
	doc.clientID = cid++;
	const ed = E.create(doc);
	ed.init({
		content: [
			{
				id: 'b',
				type: 'paragraph',
				content: [{ kind: 'text', text: 'hello world' }]
			}
		]
	});
	return { doc, ed };
};

/** push the full diff of `from` into `to` (one-way sync, like a provider). */
const push = (from: Y.Doc, to: Y.Doc) => {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
};

describe('R3 — undo restores text into the wrong paragraph', () => {
	test('sequential undo returns the atoms to the split tail', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');

		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		expect(ed.blockText('tail')).toBe('');
		um.undo();

		// OBSERVED: b='hello world', tail='' — atoms resurrected under 'b'.
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
	});

	test('binary save → reload keeps the correct ownership', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		um.undo();

		const reloaded = new Y.Doc();
		reloaded.clientID = cid++;
		Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
		const ed2 = E.create(reloaded);
		// The wrong ownership is encoded in the update itself — a reload (or a
		// peer that NEVER ran the delete) derives the same corrupted state.
		expect(ed2.blockText('b')).toBe('hello ');
		expect(ed2.blockText('tail')).toBe('world');
	});

	test('a synced peer that never ran the delete derives the same ownership', () => {
		const { doc, ed } = seed();
		const remote = new Y.Doc();
		remote.clientID = cid++;
		const red = E.create(remote);

		ed.block('b').split(6, 'tail');
		push(doc, remote); // peer synced at the split state
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		push(doc, remote); // peer receives the delete only
		um.undo();
		push(doc, remote); // peer receives the undo

		// OBSERVED on both replicas: 'hello world' / ''.
		expect(red.blockText('b')).toBe('hello ');
		expect(red.blockText('tail')).toBe('world');
		// local side pinned in the first test; replicas must agree
		expect(red.blockText('b')).toBe(ed.blockText('b'));
		expect(red.blockText('tail')).toBe(ed.blockText('tail'));
	});

	test('marks on the deleted text are restored with the atoms — in tail', () => {
		const { ed } = seed();
		ed.setMark('b', 6, 5, 'b', true); // 'world' bold before the split
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		um.undo();

		// OBSERVED: tail='' and b's runs are [{text:'hello '},{text:'world',
		// marks:{b:true}}] — the marked atoms came back under the wrong block.
		expect(ed.runs('tail')).toEqual([{ kind: 'text', text: 'world', marks: { b: true } }]);
		expect(ed.runs('b')).toEqual([{ kind: 'text', text: 'hello ' }]);
	});

	test('concurrent remote edit on b does not merge the restored tail into b', () => {
		const { doc, ed } = seed();
		const remote = new Y.Doc();
		remote.clientID = cid++;
		const red = E.create(remote);

		ed.block('b').split(6, 'tail');
		push(doc, remote);
		// Remote peer edits 'b' BEFORE the local delete — selective undo must
		// keep it while restoring 'tail'.
		red.insertText('b', 6, '!');
		push(remote, doc);
		expect(ed.blockText('b')).toBe('hello !');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		um.undo();
		push(doc, remote);

		// OBSERVED pre-repair: b='hello !world', tail='' — restored atoms
		// landed in 'b' (after the remote '!'), not in 'tail'.
		expect(ed.blockText('b')).toBe('hello !');
		expect(ed.blockText('tail')).toBe('world');
		expect(red.blockText('b')).toBe(ed.blockText('b'));
		expect(red.blockText('tail')).toBe(ed.blockText('tail'));
	});

	test('remote edit BETWEEN delete and undo — classification (see ADR)', () => {
		const { doc, ed } = seed();
		const remote = new Y.Doc();
		remote.clientID = cid++;
		const red = E.create(remote);

		ed.block('b').split(6, 'tail');
		push(doc, remote);
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		push(doc, remote);
		// The remote edit lands AFTER the delete but BEFORE the undo. The
		// doc-scoped UndoManager captures it into the LOCAL undo stack
		// (upstream trackedOrigins semantics — remote applies are tracked),
		// so the first undo pops the remote insert, not the delete.
		red.insertText('b', 6, '!');
		push(remote, doc);
		expect(ed.blockText('b')).toBe('hello !');
		um.undo(); // pops the REMOTE '!' insert — upstream capture policy,
		// not an ownership steal (the repair writes no claim here).
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('');
		um.undo(); // pops the delete — 'world' comes home to 'tail'.
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
		push(doc, remote);
		expect(red.blockText('b')).toBe('hello ');
		expect(red.blockText('tail')).toBe('world');
	});

	test('raw Y.UndoManager (no facade factory) gets the same repair', () => {
		const { doc, ed } = seed();
		ed.block('b').split(6, 'tail');
		// The repair attaches once per DOC (doc-level update observer), so a
		// directly-constructed UndoManager — e.g. the peer harness's
		// `enableUndo` — produces the same ownership as createUndoManager().
		const um = new Y.UndoManager(doc.get('blocks'), { captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		um.undo();
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
	});

	test('selection anchors in the deleted range resolve into tail after undo', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const mid = ed.anchorAt('tail', 2);
		const start = ed.anchorAt('tail', 0, 'right');
		const end = ed.anchorAt('tail', 5);
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		um.undo();
		// The anchors bound the TOMBSTONED originals, which sit at the end of
		// the resurrected run in the item sequence — so they resolve into
		// 'tail' at its right edge (block identity preserved by the repair;
		// intra-range offsets collapse to the tombstone gap, pre-existing
		// anchor semantics for deleted atoms).
		expect(ed.resolveAnchor(mid)).toEqual({ blockId: 'tail', offset: 5 });
		expect(ed.resolveAnchor(start)).toEqual({ blockId: 'tail', offset: 5 });
		expect(ed.resolveAnchor(end)).toEqual({ blockId: 'tail', offset: 5 });
	});

	test('repeated delete/undo cycles keep restoring the tail', () => {
		const { ed } = seed();
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		// Each undo writes a fresh repair claim at g+1 over the NEW copy
		// atoms; the next delete tombstones them and the next undo
		// resurrects yet another generation. Stale claims must never
		// corrupt the cycle.
		for (let i = 0; i < 2; i++) {
			ed.block('tail').deleteText(0, 5);
			expect(ed.blockText('tail')).toBe('');
			um.undo();
			expect(ed.blockText('b')).toBe('hello ');
			expect(ed.blockText('tail')).toBe('world');
		}
	});
});

describe('R3 — no repair listener (arch-v2 D12: streams need no undo repair)', () => {
	// Until D12 an undo-resurrection repair observer sat on the
	// `beforeObserverCalls` channel, once per doc. Under R2 every boundary
	// sits after the gap it was inserted into, and `redoItem` puts each copy
	// beside its tombstone — inside the stream that displayed it — so no
	// facade installs any observer there, and the undo is one update.
	const channelListeners = (doc: Y.Doc, channel: string): number =>
		(doc as unknown as { _observers?: Map<string, Set<unknown>> })._observers?.get(channel)?.size ??
		0;
	const updateListeners = (doc: Y.Doc): number => channelListeners(doc, 'update');
	const repairListeners = (doc: Y.Doc): number => channelListeners(doc, 'beforeObserverCalls');

	test('facades install no repair listener; the index listens to `update` only while reporting', () => {
		const doc = new Y.Doc();
		const baseUpdate = updateListeners(doc);
		const ed1 = E.create(doc);
		const ed2 = E.create(doc);
		expect(updateListeners(doc) - baseUpdate).toBe(0);
		expect(repairListeners(doc)).toBe(0);
		const off = ed2.onChange(() => {});
		expect(updateListeners(doc) - baseUpdate).toBe(1); // the index's report listener
		ed1.dispose();
		ed2.dispose();
		off();
		expect(updateListeners(doc)).toBe(baseUpdate); // no subscriber, no listener
		expect(repairListeners(doc)).toBe(0);
	});

	test('disposing one facade keeps undo repair working for the other', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed1 = E.create(doc);
		ed1.init({
			content: [
				{
					id: 'b',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'hello world' }]
				}
			]
		});
		const ed2 = E.create(doc);
		ed1.block('b').split(6, 'tail');
		ed1.dispose(); // repair must survive for ed2
		const um = ed2.createUndoManager({ captureTimeout: 0 });
		ed2.block('tail').deleteText(0, 5);
		um.undo();
		expect(ed2.blockText('b')).toBe('hello ');
		expect(ed2.blockText('tail')).toBe('world');
		ed2.dispose();
	});

	test('undo AFTER the last facade dispose is still repaired (Gate-H window)', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [
				{
					id: 'b',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'hello world' }]
				}
			]
		});
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		ed.block('tail').deleteText(0, 5);
		ed.dispose(); // no live facade — the doc-level listener still repairs
		um.undo();
		// The pre-fix outcome persisted b='hello world'/tail='' after a new
		// facade attached; now the repair fires without any facade.
		const ed2 = E.create(doc);
		expect(ed2.blockText('b')).toBe('hello ');
		expect(ed2.blockText('tail')).toBe('world');
		ed2.dispose();
	});
});
