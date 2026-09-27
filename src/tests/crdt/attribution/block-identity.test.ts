/**
 * Attribution identity — adversarial review 2026-09-23, P1-4/P1-5/P2-7.
 *
 * Value equality and the public block id are not enough to identify
 * which historical edit a metadata write belongs to:
 * - `lastChangedBy` suppression must key on CRDT item ownership (which
 *   replica wrote the CURRENT `l` item), not a per-replica value cache —
 *   undo on one device must not hide a later surviving same-actor edit
 *   from another device.
 * - `b/` records are keyed by block INCARNATION (the registry node's
 *   item id), not the recyclable public id — a delayed update written
 *   against an older incarnation must not contaminate a recreated block.
 * - Paragraph attribution is a block-id LINEAGE contract: contributors
 *   are the actors who committed edits while addressing that block id
 *   (plus union snapshots inherited at split/merge). A concurrent split
 *   can place an edit's atoms into a sibling whose id the editor never
 *   addressed — lineage keeps that contributor on the source id.
 */
import { describe, expect, it } from 'vitest';
import { applyUpdate, docValue, firstBlock, wireDocs, authoredDocument } from './helpers.js';
import {
	createDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };
const carol: DocumentActor = { id: 'carol', name: 'Carol' };

const joinLate = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};

const textOf = (d: EdytorDocument, blockId: string) => d.facade.blockText(blockId);
const append = (d: EdytorDocument, blockId: string, text: string) => {
	d.transact(() => d.facade.insertText(blockId, textOf(d, blockId).length, text));
};

const attrOf = (d: EdytorDocument, blockId: string) => d.attribution.block(blockId);

describe('P1-4 — same-actor lastChangedBy survives another replica’s undo', () => {
	it('undo on one device does not hide a later surviving same-actor edit', () => {
		const A = authoredDocument(docValue('x'), alice, {
			history: { captureTimeout: 0 } // every A commit its own undo step
		});
		const B = createDocument({ actor: alice }); // same ACTOR, other replica
		const C = createDocument({ actor: bob });
		joinLate(A, B);
		joinLate(A, C);
		const unwire = [wireDocs(A, B), wireDocs(A, C), wireDocs(B, C)];
		const blockId = firstBlock(A).id;

		append(A, blockId, 'A'); // alice on replica A
		append(B, blockId, 'B'); // alice on replica B
		append(C, blockId, 'C'); // bob
		append(A, blockId, 'D'); // alice on A again
		append(B, blockId, 'E'); // alice on B again — B's SECOND stamp

		for (const d of [A, B, C]) {
			expect(textOf(d, blockId)).toBe('xABCDE');
			expect(attrOf(d, blockId)?.lastChangedBy).toBe('alice');
		}

		// A undoes only ITS latest edit — B's 'E' survives as the newest
		// content. The last editor is still alice, NOT bob: undo of A's
		// `l` item must expose B's later same-value stamp, and B must
		// have WRITTEN one (item ownership, not value-cache suppression).
		A.history.undo();

		for (const d of [A, B, C]) {
			expect(textOf(d, blockId)).toBe('xABCE');
			expect(attrOf(d, blockId)?.lastChangedBy).toBe('alice');
		}
		unwire.forEach((off) => off());
		A.destroy();
		B.destroy();
		C.destroy();
	});

	it('a same-actor stamp after a foreign lastChangedBy still writes (no cache leak)', () => {
		const A = authoredDocument(docValue('x'), alice, {
			history: { captureTimeout: 0 } // each edit its own undo step
		});
		const B = createDocument({ actor: bob });
		joinLate(A, B);
		const unwire = wireDocs(A, B);
		const blockId = firstBlock(A).id;

		append(B, blockId, '1'); // bob edits — l=bob
		expect(attrOf(A, blockId)?.lastChangedBy).toBe('bob');
		append(A, blockId, '2'); // alice edits — l=alice
		expect(attrOf(B, blockId)?.lastChangedBy).toBe('alice');
		append(A, blockId, '3'); // alice again — same value, still her item
		expect(attrOf(A, blockId)?.lastChangedBy).toBe('alice');

		// Undo alice's last edit → exposes HER OWN earlier stamp.
		A.history.undo();
		expect(attrOf(B, blockId)?.lastChangedBy).toBe('alice');
		// Undo again → bob's stamp surfaces.
		A.history.undo();
		expect(attrOf(B, blockId)?.lastChangedBy).toBe('bob');
		unwire();
		A.destroy();
		B.destroy();
	});
});

describe('P1-5 — delayed writes to a recycled block id cannot contaminate', () => {
	const scenario = (deliverBeforeRecreate: boolean) => {
		const a = createDocument({ actor: alice });
		a.sync();
		const b = createDocument({ actor: bob });
		const c = createDocument({ actor: carol });
		joinLate(a, b);
		joinLate(a, c);
		const unwireAB = wireDocs(a, b);
		const unwire = [unwireAB, wireDocs(a, c)];

		a.transact(() =>
			a.facade.insertBlock({ parent: null, index: 1 }, { id: 'shared', type: 'paragraph' })
		);
		expect(c.facade.hasBlock('shared')).toBe(true);
		// Sever A↔B so carol's update (C→A) cannot reach B — the delayed
		// delivery below is the only path it ever takes.
		unwireAB();

		// Carol edits `shared` — her update is captured once, delivered to
		// A (wired) but held back from B (the "delayed old-identity write").
		let carolUpdate: Uint8Array | undefined;
		const capture = (u: Uint8Array) => {
			carolUpdate = u;
			c.doc.off('update', capture);
		};
		c.doc.on('update', capture);
		c.transact(() => c.facade.insertText('shared', 0, 'carol'));
		expect(carolUpdate).toBeDefined();

		// Alice undoes the block — her undo update is captured and
		// delivered to B directly (carol's update stays withheld).
		let undoUpdate: Uint8Array | undefined;
		const capUndo = (u: Uint8Array) => {
			undoUpdate = u;
			a.doc.off('update', capUndo);
		};
		a.doc.on('update', capUndo);
		a.history.undo();
		expect(undoUpdate).toBeDefined();
		applyUpdate(b.doc, undoUpdate!, 'alice-undo');
		expect(b.facade.hasBlock('shared')).toBe(false);

		if (deliverBeforeRecreate) {
			// Reverse delivery order: carol's write lands while nothing
			// named `shared` exists on B — then bob creates the new block.
			applyUpdate(b.doc, carolUpdate!, 'carol-late');
		}

		b.transact(() =>
			b.facade.insertBlock(
				{ parent: null, index: 1 },
				{
					id: 'shared',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'new' }]
				}
			)
		);

		if (!deliverBeforeRecreate) {
			applyUpdate(b.doc, carolUpdate!, 'carol-late');
		}

		return { a, b, c, unwire };
	};

	it.each([false, true])(
		'delivery %s recreation — the new block keeps only bob',
		async (deliverBeforeRecreate) => {
			const { a, b, c, unwire } = scenario(deliverBeforeRecreate);

			// Bob's block content is untouched by the old-incarnation edit.
			expect(b.facade.blockText('shared')).toBe('new');
			const attr = b.attribution.block('shared');
			expect(attr?.createdBy).toBe('bob');
			expect(attr?.contributors).toEqual(new Set(['bob']));
			expect(attr?.lastChangedBy).toBe('bob');

			unwire.forEach((off) => off());
			a.destroy();
			b.destroy();
			c.destroy();
		}
	);

	it('save/load keeps the recreated block insulated', () => {
		const { b, unwire, a, c } = scenario(false);
		const restored = createDocument({ actor: carol });
		applyUpdate(restored.doc, b.encode());
		restored.sync();
		expect(restored.attribution.block('shared')?.contributors).toEqual(new Set(['bob']));
		expect(restored.facade.blockText('shared')).toBe('new');
		restored.destroy();
		unwire.forEach((off) => off());
		a.destroy();
		b.destroy();
		c.destroy();
	});
});

describe('P2-7 — paragraph attribution is a block-id lineage contract', () => {
	it('a concurrent split keeps the late-arriving contributor on the source id', () => {
		// CONTRACT (decided): `contributors(id)` = actors who committed an
		// edit while addressing block `id`, plus the union snapshot a
		// split/merge copies to the new sibling. It is NOT "actors whose
		// text currently renders in this block" — a concurrent split can
		// carry an edit's atoms into a sibling whose id the editor never
		// addressed; lineage keeps that contributor on the source id.
		const a = createDocument({ actor: alice });
		a.sync({ children: [] });
		a.transact(() =>
			a.facade.insertBlock(
				{ parent: null, index: 0 },
				{
					id: 'shared',
					type: 'paragraph',
					content: [{ kind: 'text', text: 'abcd' }]
				}
			)
		);
		const b = createDocument({ actor: bob });
		joinLate(a, b);

		// Both go offline: alice splits abcd → ab|cd; bob inserts X at 3
		// (addressing `shared`, which his replica still sees as abcd).
		let splitUpdate: Uint8Array | undefined;
		let insertUpdate: Uint8Array | undefined;
		const capA = (u: Uint8Array) => {
			splitUpdate = u;
			a.doc.off('update', capA);
		};
		const capB = (u: Uint8Array) => {
			insertUpdate = u;
			b.doc.off('update', capB);
		};
		a.doc.on('update', capA);
		b.doc.on('update', capB);
		a.transact(() => a.facade.splitBlock('shared', 2, 'tail'));
		b.transact(() => b.facade.insertText('shared', 3, 'X'));
		expect(splitUpdate).toBeDefined();
		expect(insertUpdate).toBeDefined();

		// Reconnect: the concurrent updates cross.
		applyUpdate(a.doc, insertUpdate!, 'bob-late');
		applyUpdate(b.doc, splitUpdate!, 'alice-late');

		// Converged content: source 'ab', tail 'cXd' — bob's X landed in
		// the TAIL's visible content while his stamp addressed `shared`.
		expect(a.facade.blockText('shared')).toBe('ab');
		expect(a.facade.blockText('tail')).toBe('cXd');
		expect(b.facade.blockText('shared')).toBe('ab');
		expect(b.facade.blockText('tail')).toBe('cXd');

		// Lineage: bob edited the `shared` id → he is a source contributor
		// even though none of his text renders there.
		expect(a.attribution.block('shared')?.contributors).toEqual(new Set(['alice', 'bob']));
		expect(b.attribution.block('shared')?.contributors).toEqual(new Set(['alice', 'bob']));

		// The tail inherits the pre-split snapshot (alice). Whether bob
		// also appears there is an LWW-resolution detail of the tail's
		// record — the only hard requirements are convergence + alice.
		expect(a.attribution.block('tail')?.contributors).toContain('alice');
		expect(a.attribution.block('tail')?.contributors).toEqual(
			b.attribution.block('tail')?.contributors
		);
		a.destroy();
		b.destroy();
	});
});
