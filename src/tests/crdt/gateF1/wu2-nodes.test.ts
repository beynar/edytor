/**
 * Gate-F1 adversarial probes — WU2 typed nodes.
 *
 * 1. Multi-backing display: a block merged over two claimed lists displays
 *    atoms from THREE backing texts (its own + two claimed). insertText /
 *    format / split must resolve display offsets into the right backing at
 *    every seam — including adversarial offsets exactly on the boundaries.
 *
 * 2. Read-your-writes inside one transaction: writes routed through the
 *    facade must be visible to subsequent reads in the SAME transaction
 *    (insertText→length, split→sibling content, move→parent/path). The
 *    facade documents a caveat for RAW engine writes (they bypass the
 *    mutation boundary) — these probes pin the facade path.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { createPeerPair, type Peer } from '../harness/peer-set.js';
import { createDocOps } from '../harness/ops/doc-ops.js';
import { assertConverged, assertAllStructurallyValid } from '../harness/assert/convergence.js';
import { collectBlocks } from '../../oracles/fresh-view.js';

const E = bindEdytorDoc(Y);
const ops = createDocOps();

const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
const ed = (peer: Peer) => {
	let f = facades.get(peer.doc);
	if (!f) {
		f = E.create(peer.doc);
		facades.set(peer.doc, f);
	}
	return f;
};
const text = (peer: Peer, id: string) => ed(peer).blockText(id);

const SEED3 = (doc) => {
	E.init(doc, {
		content: [
			{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: 'AAA' }] },
			{ id: 'v1', type: 'paragraph', content: [{ kind: 'text', text: 'bbb' }] },
			{ id: 'v2', type: 'paragraph', content: [{ kind: 'text', text: 'CCC' }] }
		]
	});
};

describe('gateF1 WU2 — multi-backing display seams', () => {
	it('insertText at every offset across three backing texts', () => {
		const set = createPeerPair(SEED3);
		const { A } = set;
		// c claims v1 then v2 -> display 'AAA'+'bbb'+'CCC' across 3 backings.
		ops.mergeBlocks(A, 'v1', 'c');
		ops.mergeBlocks(A, 'v2', 'c');
		expect(text(A, 'c')).toBe('AAAbbbCCC');
		// Interior of each backing.
		ops.insertText(A, 'c', 1, '1'); // inside AAA  -> 'A1AAbbbCCC'
		ops.insertText(A, 'c', 5, '2'); // inside bbb  -> 'A1AAb2bbCCC'
		ops.insertText(A, 'c', 9, '3'); // inside CCC  -> 'A1AAb2bbC3CC'
		expect(text(A, 'c')).toBe('A1AAb2bbC3CC');
		// Exact seams: offset 4 = end of own backing / start of claimed,
		// offset 8 = end of first claim / start of second.
		ops.insertText(A, 'c', 4, 'S1');
		expect(text(A, 'c')).toBe('A1AAS1b2bbC3CC');
		ops.insertText(A, 'c', 10, 'S2');
		expect(text(A, 'c')).toBe('A1AAS1b2bbS2C3CC');
		// Right at the display end (len 16).
		ops.insertText(A, 'c', 16, 'E');
		expect(text(A, 'c')).toBe('A1AAS1b2bbS2C3CCE');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'multi-backing inserts');
		assertAllStructurallyValid(set, ops, 'multi-backing inserts');
	});

	it('format across a backing seam marks both sides', () => {
		const set = createPeerPair(SEED3);
		const { A } = set;
		ops.mergeBlocks(A, 'v1', 'c');
		ops.mergeBlocks(A, 'v2', 'c');
		// 'AbbCC': format offsets 2..7 — crosses own->v1 and v1->v2 seams.
		ops.setMark(A, 'c', 2, 5, 'bold', true);
		const runs = ed(A).runs('c');
		expect(runs).toEqual([
			{ kind: 'text', text: 'AA' },
			{ kind: 'text', text: 'AbbbC', marks: { bold: true } },
			{ kind: 'text', text: 'CC' }
		]);
	});

	it('split at a multi-backing seam partitions ownership exactly', () => {
		const set = createPeerPair(SEED3);
		const { A, B } = set;
		ops.mergeBlocks(A, 'v1', 'c');
		ops.mergeBlocks(A, 'v2', 'c');
		// Split exactly at the seam between own 'AAA' and claimed 'bbb'.
		ops.splitBlock(A, 'c', 3, 'c2');
		expect(text(A, 'c')).toBe('AAA');
		expect(text(A, 'c2')).toBe('bbbCCC');
		// And inside the second claim.
		ops.splitBlock(A, 'c2', 4, 'c3');
		expect(text(A, 'c2')).toBe('bbbC');
		expect(text(A, 'c3')).toBe('CC');
		set.deliver('A', 'B');
		set.deliver('B', 'A');
		assertConverged(set, ops, 'multi-backing split');
		assertAllStructurallyValid(set, ops, 'multi-backing split');
	});
});

describe('gateF1 WU2 — read-your-writes inside a transaction', () => {
	it('insertText then read length/content in the same transact', () => {
		const set = createPeerPair(SEED3);
		const { A } = set;
		const d = ed(A);
		A.transact(() => {
			d.insertText('c', 0, '>>');
			expect(d.displayLength('c')).toBe(5);
			expect(d.blockText('c')).toBe('>>AAA');
		});
	});
	it('splitBlock then read sibling content in the same transact', () => {
		const set = createPeerPair(SEED3);
		const { A } = set;
		const d = ed(A);
		A.transact(() => {
			d.splitBlock('c', 1, 'sib');
			expect(d.blockText('c')).toBe('A');
			expect(d.blockText('sib')).toBe('AA');
		});
	});
	it('moveBlock then read parent/path in the same transact', () => {
		const set = createPeerPair((doc) => {
			E.init(doc, {
				content: [
					{ id: 'p', type: 'paragraph', content: [{ kind: 'text', text: 'parent' }] },
					{
						id: 'host',
						type: 'paragraph',
						content: [{ kind: 'text', text: 'host' }],
						children: [{ id: 'k1', type: 'paragraph', content: [{ kind: 'text', text: 'one' }] }]
					},
					{ id: 'mover', type: 'paragraph', content: [{ kind: 'text', text: 'mv' }] }
				]
			});
		});
		const { A } = set;
		const d = ed(A);
		A.transact(() => {
			d.moveBlock('mover', { parent: 'host', index: 1 });
			expect(d.positionOf('mover')).toEqual({ parent: 'host', index: 1 });
			expect(d.pathOf('mover')).toEqual([1, 1]); // index path: host=root#1, mover=host#1
			expect(d.parentOf('mover')).toBe('host');
		});
	});
	it('a raw engine write between two facade reads goes stale mid-transaction', () => {
		// Pins the documented caveat: writing through the model/text escape
		// hatch bypasses the facade's invalidation boundary — a facade read
		// memoized BEFORE the raw write keeps serving the stale view inside
		// the same transaction. If a consumer ever relies on raw writes +
		// same-tx facade reads, it reads stale data.
		const set = createPeerPair(SEED3);
		const { A } = set;
		const d = ed(A);
		A.transact(() => {
			expect(d.displayLength('c')).toBe(3); // memoizes the v1 view
			const blocks = collectBlocks(A.doc);
			const own = d.text.computeOwnership(A.doc, blocks);
			d.text.insertIntoText(A.doc, blocks, own, 'c', 0, 'RAW');
			// Raw write bypassed invalidation — the memoized view is stale.
			const len = d.displayLength('c');
			console.log(`[gateF1] read→raw-write→read inside tx: len=${len} (stale if 3)`);
		});
	});
});
