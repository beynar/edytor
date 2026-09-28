/**
 * U1 — block attribution × undo. The load-bearing shape:
 *
 * - `lastChangedBy` (`l`, a block-node attr) lives INSIDE the
 *   registry-scoped UndoManager — the engine restores the previous `l`
 *   item on undo for free.
 * - `createdBy`/`contributors` (`b/<id>` records on the `blockattr`
 *   root) live OUTSIDE that scope — union membership survives undo.
 *
 * The counterexample these tests encode: alice edits on replica A
 * (writes `l` item A_l), replica B — SAME actor — receives the edit
 * and edits the same block (B has never stamped → B writes its own
 * `l` item B_l even though the stored value already reads 'alice').
 * A then undoes its own edit: A's items die, B's `l` survives →
 * `lastChangedBy` stays 'alice' rather than vanishing, and the
 * contributor set still holds 'alice'.
 */
import { describe, expect, it } from 'vitest';
import { applyUpdate, firstBlock, wireDocs } from './helpers.js';
import { createDocument, type DocumentActor } from '../../../lib/crdt/index.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };

/** Hydrate `b` from `a`'s encoded state and mark it ready. */
const joinLate = (a: ReturnType<typeof createDocument>, b: ReturnType<typeof createDocument>) => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};

describe('block attribution × undo', () => {
	it('same actor, two replicas: undo keeps the surviving `l` item and the contributor', () => {
		// Bootstrap doc — the empty record is scaffolding only, so the
		// first edit really writes `l` (no creation stamp suppresses it).
		const a = createDocument({ actor: alice });
		a.sync();
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: alice }); // SAME actor, second replica
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		// A edits — writes its own `l` item + contributor add.
		a.transact(() => a.facade.insertText(blockId, 0, 'A'));
		expect(b.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		expect([...b.attribution.block(blockId)!.contributors]).toEqual(['alice']);

		// B (same actor) edits the same block. B's suppression memory is
		// empty — it must write its own `l` item even though the stored
		// value already equals 'alice'.
		b.history.stopCapturing();
		b.transact(() => b.facade.insertText(blockId, 1, 'B'));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('alice');

		// A undoes its own edit. A's items die — A_l was already deleted
		// by B_l's integration, so `l` resolves to B's surviving item.
		a.history.undo();
		const attr = a.attribution.block(blockId);
		expect(attr?.lastChangedBy).toBe('alice');
		expect([...attr!.contributors].sort()).toEqual(['alice']);
		// Convergent on both replicas.
		expect(b.attribution.block(blockId)).toEqual(attr);
		unwire();
		a.destroy();
		b.destroy();
	});

	it("undo restores the previous lastChangedBy when another actor's edit is undone", () => {
		const a = createDocument({ actor: alice });
		a.sync();
		const blockId = firstBlock(a).id;
		const b = createDocument({ actor: bob });
		joinLate(a, b);
		const unwire = wireDocs(a, b);

		a.transact(() => a.facade.insertText(blockId, 0, 'A'));
		expect(b.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		b.history.stopCapturing();
		b.transact(() => b.facade.insertText(blockId, 1, 'B'));
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('bob');

		// Bob undoes his edit — bob's `l` item dies, alice's resurfaces.
		b.history.undo();
		expect(a.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		expect(b.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		// Bob still contributed (union membership is monotonic), and the
		// undo itself stamped nothing for bob.
		expect([...a.attribution.block(blockId)!.contributors].sort()).toEqual(['alice', 'bob']);
		unwire();
		a.destroy();
		b.destroy();
	});

	it('contributor membership survives undo of the only contributing edit', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		const blockId = firstBlock(d).id;
		d.transact(() => d.facade.insertText(blockId, 0, 'x'));
		expect(d.attribution.block(blockId)?.lastChangedBy).toBe('alice');
		d.history.undo();
		const attr = d.attribution.block(blockId);
		// The contributor entry was never in undo scope — it survives.
		expect([...attr!.contributors].sort()).toEqual(['alice']);
		// `l` was in scope — with nothing else stamped, it reverts to absent.
		expect(attr?.lastChangedBy).toBeUndefined();
		expect(attr?.createdBy).toBeUndefined(); // system bootstrap — never authored
		d.destroy();
	});

	it('undo of a block creation removes the block but keeps its durable record', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		d.transact(() =>
			d.facade.insertBlock(
				{ parent: null, index: 1 },
				{ id: 'b2', type: 'paragraph', content: [{ kind: 'text', text: 'two' }] }
			)
		);
		expect(d.attribution.block('b2')).toEqual({
			createdBy: 'alice',
			contributors: new Set(['alice']),
			lastChangedBy: 'alice'
		});
		d.history.undo();
		// The undo withdraws the block (hist.undo.withdraw): hidden, its node
		// (and in-scope `l`) kept; `b/` records are keyed by block id and out
		// of undo scope — the record persists (like tombstone attribution).
		expect(d.facade.isVisibleBlock('b2')).toBe(false);
		const attr = d.attribution.block('b2');
		expect(attr?.createdBy).toBe('alice');
		expect([...attr!.contributors]).toEqual(['alice']);
		d.destroy();
	});

	it('redo replays the creation attribution with it', () => {
		const d = createDocument({ actor: alice });
		d.sync();
		d.transact(() =>
			d.facade.insertBlock({ parent: null, index: 1 }, { id: 'b2', type: 'paragraph' })
		);
		d.history.undo();
		d.history.redo();
		const attr = d.attribution.block('b2');
		expect(attr?.createdBy).toBe('alice');
		expect(attr?.lastChangedBy).toBe('alice');
		expect([...attr!.contributors]).toEqual(['alice']);
		d.destroy();
	});
});
