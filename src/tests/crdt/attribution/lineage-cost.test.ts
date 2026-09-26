/**
 * Lineage ring — document-size cost projections.
 *
 * Measures `encode()` totals and per-update wire bytes for the ring
 * across varied subtree shapes and depths. Prints a table; asserts the
 * hard invariants (feature off / same-actor typing ⇒ byte-identical).
 *
 * Wire model: each entry is one ContentAny list item on the block's
 * `brec` record carrying `{a?, by, s, t, j}` — cost ≈ JSON snapshot
 * bytes + small struct overhead. The update emitted for a displacing
 * op additionally carries the normal content write + `l` stamp.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { docValue, firstBlock, wireDocs } from './helpers.js';
import {
	createDocument,
	type DocumentActor,
	type EdytorDocument,
	type JSONDoc
} from '../../../lib/crdt/index.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice' };
const bob: DocumentActor = { id: 'bob', name: 'Bob' };

const encodeSize = (d: EdytorDocument): number => Y.encodeStateAsUpdate(d.doc).length;

/** Collect the update bytes emitted by `fn` on `d`. */
const updateBytes = (d: EdytorDocument, fn: () => void): number => {
	let total = 0;
	const on = (u: Uint8Array) => {
		total += u.length;
	};
	d.doc.on('update', on);
	try {
		fn();
	} finally {
		d.doc.off('update', on);
	}
	return total;
};

const textOf = (d: EdytorDocument, blockId: string) => d.facade.blockText(blockId);
const append = (d: EdytorDocument, blockId: string, text: string) => {
	d.transact(() => d.facade.insertText(blockId, textOf(d, blockId).length, text));
};

/** Seed `doc` on A, wire a bob replica, return [A, B, blockId]. */
const pair = (doc: JSONDoc, depth: number) => {
	const A = createDocument({ value: doc, actor: alice, lineage: { depth } });
	const B = createDocument({ actor: bob, lineage: { depth }, history: { captureTimeout: 0 } });
	applyInit(B, A);
	return { A, B, blockId: firstBlock(A).id };
};
const applyInit = (B: EdytorDocument, A: EdytorDocument): void => {
	Y.applyUpdate(B.doc, A.encode());
	B.sync();
};

const pad = (s: string | number, n: number) => String(s).padStart(n);
const row = (name: string, base: number, withRing: number, extra = '') =>
	console.log(
		`  ${name.padEnd(46)} ${pad(base, 8)}B → ${pad(withRing, 8)}B  (+${withRing - base}B) ${extra}`
	);

describe('lineage — document-size cost projections', () => {
	it('feature off vs on — zero cost until a handoff', () => {
		const doc = docValue('hello world');
		const off = createDocument({ value: doc, actor: alice });
		const on = createDocument({ value: doc, actor: alice, lineage: { depth: 20 } });
		// Same-actor typing on the ON doc — the ring stays empty.
		const id = firstBlock(on).id;
		for (let i = 0; i < 50; i++) append(on, id, `k${i}`);
		const offId = firstBlock(off).id;
		for (let i = 0; i < 50; i++) append(off, offId, `k${i}`);
		row(
			'off: seed + 50 same-actor keys',
			encodeSize(createDocument({ value: doc })),
			encodeSize(off)
		);
		row(
			'on(d20): seed + 50 same-actor keys',
			encodeSize(createDocument({ value: doc })),
			encodeSize(on)
		);
		// The ring contributes NOTHING while the same actor owns `l`.
		expect(on.attribution.history(id)).toEqual([]);
		off.destroy();
		on.destroy();
	});

	it('per-entry cost by subtree shape (depth 20, one handoff each)', () => {
		const shapes: [string, JSONDoc][] = [
			['tiny text (5 chars)', { children: [{ type: 'paragraph', content: [{ text: 'hello' }] }] }],
			[
				'paragraph (~200 chars)',
				{ children: [{ type: 'paragraph', content: [{ text: 'lorem ipsum '.repeat(17) }] }] }
			],
			[
				'paragraph (~2000 chars)',
				{ children: [{ type: 'paragraph', content: [{ text: 'lorem ipsum '.repeat(167) }] }] }
			],
			[
				'marks-heavy (10 runs, 3 marks)',
				{
					children: [
						{
							type: 'paragraph',
							content: Array.from({ length: 10 }, (_, i) => ({
								text: `run${i} `,
								marks: { bold: i % 2 === 0, italic: i % 3 === 0, code: i % 5 === 0 }
							}))
						}
					]
				}
			],
			[
				'inline atoms (5 mentions)',
				{
					children: [
						{
							type: 'paragraph',
							content: Array.from({ length: 5 }, (_, i) => ({
								type: 'mention',
								id: `m${i}`,
								data: { user: `user-${i}`, label: `User Number ${i}` }
							}))
						}
					]
				}
			],
			[
				'nested children (3 levels × 2 kids)',
				{
					children: [
						{
							type: 'section',
							content: [{ text: 'parent' }],
							children: Array.from({ length: 2 }, (_, i) => ({
								type: 'section',
								content: [{ text: `kid${i}` }],
								children: Array.from({ length: 2 }, (_, j) => ({
									type: 'paragraph',
									content: [{ text: `grandkid ${i}.${j} with a bit of text` }]
								}))
							}))
						}
					]
				}
			],
			[
				'data-heavy attrs',
				{
					children: [
						{
							type: 'paragraph',
							data: {
								meta: { author: 'x'.repeat(100), tags: ['a', 'b', 'c'], flags: { a: 1, b: 2 } },
								rev: 42
							},
							content: [{ text: 'body' }]
						}
					]
				}
			]
		];
		for (const [name, doc] of shapes) {
			const { A, B, blockId } = pair(doc, 20);
			const base = encodeSize(B);
			const bytes = updateBytes(B, () => append(B, blockId, '+bob'));
			row(name, base, encodeSize(B), `update emitted: ${bytes}B`);
			expect(B.attribution.history(blockId)).toHaveLength(1);
			A.destroy();
			B.destroy();
		}
	});

	it('ring growth vs depth — one block, K handoffs', () => {
		for (const depth of [1, 5, 20]) {
			const { A, B, blockId } = pair(docValue('base'), depth);
			const base = encodeSize(A);
			let emitted = 0;
			// Alternate handoffs depth+2 times to prove the cap holds.
			for (let i = 0; i < depth + 2; i++) {
				const d = i % 2 === 0 ? B : A;
				emitted += updateBytes(d, () => append(d, blockId, `x${i}`));
				Y.applyUpdate(i % 2 === 0 ? A.doc : B.doc, i % 2 === 0 ? B.encode() : A.encode());
			}
			const ring = A.attribution.history(blockId)!;
			row(`depth ${depth} (${depth + 2} handoffs)`, base, encodeSize(A), `ring=${ring.length}`);
			expect(ring.length).toBeLessThanOrEqual(depth);
			A.destroy();
			B.destroy();
		}
	});

	it('many blocks: 50 blocks × 5 handoffs each (depth 5)', () => {
		const doc: JSONDoc = {
			children: Array.from({ length: 50 }, (_, i) => ({
				type: 'paragraph',
				content: [{ text: `block ${i} with representative content` }]
			}))
		};
		const A = createDocument({ value: doc, actor: alice, lineage: { depth: 5 } });
		const B = createDocument({ actor: bob, lineage: { depth: 5 }, history: { captureTimeout: 0 } });
		applyInit(B, A);
		const off = wireDocs(A, B);
		const base = encodeSize(A);
		const ids = A.facade.project().children.map((c) => c.id);
		for (let r = 0; r < 5; r++) {
			const d = r % 2 === 0 ? B : A;
			for (const id of ids) append(d, id, `·${r}`);
		}
		row('50 blocks × 5 transitions (depth 5)', base, encodeSize(A));
		off();
		A.destroy();
		B.destroy();
	});

	it('destructive events: delete of a 3-level subtree; undo capture', () => {
		const tree: JSONDoc = {
			children: [
				{
					type: 'section',
					content: [{ text: 'root' }],
					children: Array.from({ length: 3 }, (_, i) => ({
						type: 'paragraph',
						content: [{ text: `child ${i} — some longer content to measure` }],
						children: [{ type: 'paragraph', content: [{ text: `gc ${i}` }] }]
					}))
				}
			]
		};
		const { A, B, blockId } = pair(tree, 10);
		const base = encodeSize(A);
		const delBytes = updateBytes(B, () => B.transact(() => B.facade.deleteBlock(blockId)));
		row(
			'delete capture (subtree incl. 3 kids + 3 grandkids)',
			base,
			encodeSize(B),
			`update: ${delBytes}B`
		);
		const undoBytes = updateBytes(B, () => B.history.undo());
		row('undo-of-delete capture', encodeSize(B), encodeSize(B), `undo tx: ${undoBytes}B`);
		A.destroy();
		B.destroy();
	});

	it('steady state at depth 1: visible ring stays 1 — measures per-handoff tombstone growth', () => {
		// depth is a LIVE-entry bound, not a storage bound: each handoff
		// appends one entry and trims the previous into a tombstone, so
		// encoded size keeps growing (slowly) even though `history()`
		// always shows one entry. Log both regimes.
		for (const chars of [5, 2000]) {
			const { A, B, blockId } = pair(docValue('x'.repeat(chars)), 1);
			const off = wireDocs(A, B);
			const base = encodeSize(A);
			for (let i = 0; i < 40; i++) append(i % 2 === 0 ? B : A, blockId, '·');
			const grown = encodeSize(A);
			row(
				`40 handoffs depth 1, ${chars}-char block`,
				base,
				grown,
				`ring=${A.attribution.history(blockId)!.length}, +${((grown - base) / 40).toFixed(0)}B/handoff`
			);
			expect(A.attribution.history(blockId)).toHaveLength(1);
			off();
			A.destroy();
			B.destroy();
		}
	});
});
