/**
 * U07 regression — initialization must be O(N), not O(N²).
 *
 * The defect: `init` looped `M.insertBlock` per spec inside one
 * transaction. Each call ran `liveChildrenOf` → `modelCtx()` →
 * `syncTransaction()`, which re-folded the transaction's ACCUMULATING
 * `changed` map — insert i re-read i-1 registry subs, so a flat N-block
 * init cost exactly N²+2N registry `getAttr` calls (probe: 1,002,000 at
 * N=1000). The fix is the bulk `M.insertBlocks`: one sibling read + a
 * local rank chain for the whole batch — now ~3N (N validation reads +
 * the intrinsic 2N commit fold).
 *
 * These tests pin (a) the linear counter bound inline — the same
 * `Y.Node.prototype.getAttr` instrumentation as the audit probe — and
 * (b) the semantics that must not move: read-your-writes under repeated
 * same-key writes mid-transaction, all-or-nothing validation, nested
 * specs, marks/inlines, seed-if-empty, concurrent-init dedupe, and the
 * bootstrap-before-history ordering.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindDocument, bindEdytorDoc } from '../../../lib/crdt/index.js';
import { bindModel } from '../../oracles/model-ops.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);
const M = bindModel(Y);
const D = bindDocument(Y);

const newDoc = () => {
	const doc = new Y.Doc();
	doc.clientID = 7;
	return doc;
};

const flatJson = (n, chars = 40) => ({
	children: Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `block ${i} `.padEnd(chars, 'x') }]
	}))
});

const topIds = (ed) => ed.project().children.map((b) => b.id);

/**
 * Probe-identical instrumentation: count `getAttr`/`forEachAttr` calls on
 * the flat `blocks` registry node, split by whether a transaction is in
 * flight (mid-tx = read-your-writes fold work; commit = one-shot event
 * fold). Returns a restore function.
 */
const instrumentRegistry = (counts) => {
	const originalGet = Y.Node.prototype.getAttr;
	const originalEach = Y.Node.prototype.forEachAttr;
	const isRegistry = (node) => node.doc?.share?.get('blocks') === node;
	Y.Node.prototype.getAttr = function (...args) {
		if (isRegistry(this)) {
			counts.lookups++;
			if (this.doc._transaction != null) counts.midTx++;
			else counts.commit++;
		}
		return originalGet.apply(this, args);
	};
	Y.Node.prototype.forEachAttr = function (cb) {
		if (!isRegistry(this)) return originalEach.call(this, cb);
		counts.scans++;
		return originalEach.call(this, (v, k, n) => {
			counts.entries++;
			return cb(v, k, n);
		});
	};
	return () => {
		Y.Node.prototype.getAttr = originalGet;
		Y.Node.prototype.forEachAttr = originalEach;
	};
};

describe('U7 — init quadratic removal', () => {
	it('flat create performs O(N) registry lookups (was N²+2N)', () => {
		const counts = { lookups: 0, midTx: 0, commit: 0, scans: 0, entries: 0 };
		const restore = instrumentRegistry(counts);
		try {
			const N = 400;
			const document = D.createDocument({ value: flatJson(N), actor: { id: 'p' } });
			document.destroy();
			// Post-fix shape: N mid-transaction validation reads + the
			// intrinsic 2N commit fold = 3N. The bound leaves 2× headroom
			// while still failing hard on any N² regression (160,000 vs
			// 3,200 at N=400 — pre-fix this was 161,600).
			expect(counts.lookups).toBeLessThanOrEqual(8 * N);
			expect(counts.midTx).toBeLessThanOrEqual(4 * N);
			expect(counts.commit).toBeLessThanOrEqual(4 * N);
		} finally {
			restore();
		}
	});

	it('load performs O(N) registry work (unchanged path)', () => {
		const document = D.createDocument({ value: flatJson(200), actor: { id: 'p' } });
		const encoded = document.encode();
		document.destroy();
		const counts = { lookups: 0, midTx: 0, commit: 0, scans: 0, entries: 0 };
		const restore = instrumentRegistry(counts);
		try {
			const loaded = D.loadDocument(encoded, { actor: { id: 'p' } });
			loaded.destroy();
			expect(counts.lookups).toBeLessThanOrEqual(4 * 200);
			expect(counts.scans).toBeLessThanOrEqual(2);
			expect(counts.entries).toBe(200);
		} finally {
			restore();
		}
	});

	it('mid-transaction reads see repeated writes to the same attr/text', () => {
		const doc = newDoc();
		E.init(doc);
		const ed = E.create(doc);
		ed.transact(() => {
			// New block mid-transaction — its rec exists only through the
			// read-your-writes fold of the in-flight changed map.
			expect(
				ed.insertBlock({ parent: null, index: 1 }, { id: 'x', type: 'paragraph' }).status
			).toBe('applied');
			// Repeat writes to the SAME registry attr key in one transaction:
			// `changed` holds one (type,key) pair no matter how many writes —
			// the fold must still surface the latest value every read.
			ed.setBlockType('x', 'list');
			ed.setBlockType('x', 'quote');
			ed.setBlockData('x', { n: 1 });
			ed.setBlockData('x', { n: 2 });
			ed.insertText('x', 0, 'a');
			ed.insertText('x', 0, 'b');
			expect(ed.project().children[1].id).toBe('x');
			expect(ed.blockTypeOf('x')).toBe('quote');
			expect(ed.blockDataOf('x')).toEqual({ n: 2 });
			expect(ed.blockText('x')).toBe('ba');
		});
		// Committed state matches what the mid-transaction reads saw.
		expect(ed.blockTypeOf('x')).toBe('quote');
		expect(ed.blockDataOf('x')).toEqual({ n: 2 });
		expect(ed.blockText('x')).toBe('ba');
	});

	it('init followed immediately by facade ops behaves identically', () => {
		const document = D.createDocument({ value: flatJson(3), actor: { id: 'p' } });
		const ed = document.facade;
		expect(topIds(ed)).toEqual(['b0', 'b1', 'b2']);
		ed.insertText('b0', 0, 'pre ');
		expect(ed.blockText('b0')).toMatch(/^pre block 0/);
		const whole = ed.blockText('b1');
		expect(ed.splitBlock('b1', 3, 'b1x').status).toBe('applied');
		expect(topIds(ed)).toEqual(['b0', 'b1', 'b1x', 'b2']);
		expect(ed.blockText('b1') + ed.blockText('b1x')).toBe(whole);
		document.destroy();
	});

	it('nested init content preserves child order and caller ids', () => {
		const doc = newDoc();
		E.init(doc, {
			content: [
				{
					id: 'p',
					type: 'list',
					content: [{ kind: 'text', text: 'parent' }],
					children: [
						{ id: 'c1', type: 'paragraph', content: [{ kind: 'text', text: 'a' }] },
						{
							id: 'c2',
							type: 'paragraph',
							content: [{ kind: 'text', text: 'b' }],
							children: [{ id: 'g1', type: 'paragraph', content: [{ kind: 'text', text: 'g' }] }]
						}
					]
				},
				{ id: 'tail', type: 'paragraph' }
			]
		});
		const ed = E.create(doc);
		const proj = ed.project();
		expect(proj.children.map((b) => b.id)).toEqual(['p', 'tail']);
		expect(proj.children[0].children.map((b) => b.id)).toEqual(['c1', 'c2']);
		expect(proj.children[0].children[1].children.map((b) => b.id)).toEqual(['g1']);
		expect(ed.blockText('g1')).toBe('g');
	});

	it('init content carries marks, inlines and data verbatim', () => {
		const doc = newDoc();
		E.init(doc, {
			content: [
				{
					id: 'm',
					type: 'paragraph',
					data: { level: 2 },
					content: [
						{ kind: 'text', text: 'a', marks: { bold: true } },
						{ kind: 'inline', id: 'i1', type: 'mention', data: { user: 'u' } },
						{ kind: 'text', text: 'b' }
					]
				}
			]
		});
		const ed = E.create(doc);
		const block = ed.project().children[0];
		expect(block.data).toEqual({ level: 2 });
		expect(block.content).toEqual([
			{ kind: 'text', text: 'a', marks: { bold: true } },
			{ kind: 'inline', id: 'i1', type: 'mention', data: { user: 'u' } },
			{ kind: 'text', text: 'b' }
		]);
		expect(ed.toJSON().children[0].content).toHaveLength(3);
	});

	it('init with an empty content list still seeds the bootstrap block', () => {
		const doc = newDoc();
		E.init(doc, { content: [] });
		const ed = E.create(doc);
		expect(topIds(ed)).toEqual([DEFAULT_SEED_ID]);
	});

	it('init on a non-empty doc is a no-op (seed-if-empty)', () => {
		const doc = newDoc();
		E.init(doc, { content: [{ id: 'a', type: 'paragraph' }] });
		E.init(doc, { content: [{ id: 'z', type: 'paragraph' }] });
		const ed = E.create(doc);
		expect(topIds(ed)).toEqual(['a']);
	});

	it('a dup id inside init content falls back to per-spec insertion', () => {
		const doc = newDoc();
		E.init(doc, {
			content: [
				{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'kept?' }] },
				{ id: 'a', type: 'paragraph' },
				{ id: 'b', type: 'paragraph' }
			]
		});
		const ed = E.create(doc);
		// The bulk batch is all-or-nothing and refuses on the dup; init then
		// retries per-spec so valid blocks still load and only the dup is
		// skipped — the doc is never left silently empty.
		expect(ed.listBlockIds().sort()).toEqual(['a', 'b']);
		expect(ed.blockText('a')).toBe('kept?');
		expect(E.isInitialized(doc)).toBe(true);
		// Registry is non-empty now — a later init is a no-op.
		E.init(doc);
		expect(ed.listBlockIds().sort()).toEqual(['a', 'b']);
	});

	it('concurrent inits with the same ids dedupe to one survivor per id', () => {
		const a = new Y.Doc();
		a.clientID = 11;
		const b = new Y.Doc();
		b.clientID = 22;
		const content = [
			{ id: 's0', type: 'paragraph', content: [{ kind: 'text', text: 'same id' }] },
			{ id: 's1', type: 'paragraph' }
		];
		E.init(a, { content });
		E.init(b, { content });
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
		const ea = E.create(a);
		const eb = E.create(b);
		// Same-key registry writes collapse to one node per id on both
		// replicas — no duplicated blocks, identical projection.
		expect(ea.listBlockIds()).toEqual(['s0', 's1']);
		expect(eb.listBlockIds()).toEqual(['s0', 's1']);
		expect(eb.project()).toEqual(ea.project());
	});

	it('undo after init never removes the seeded/bootstrap content', () => {
		const document = D.createDocument({ value: flatJson(5), actor: { id: 'p' } });
		const before = document.facade.listBlockIds();
		expect(before).toHaveLength(5);
		// History attaches lazily AFTER init — init predates capture.
		document.history.undo();
		expect(document.facade.listBlockIds()).toEqual(before);
		document.destroy();
	});
});

describe('U7 — insertBlocks (model-level bulk path)', () => {
	it('appends N specs in order at the root in one transaction', () => {
		const doc = newDoc();
		const updates = (() => {
			let n = 0;
			doc.on('update', () => n++);
			return () => n;
		})();
		expect(
			M.insertBlocks(
				doc,
				{ parent: null, index: Number.MAX_SAFE_INTEGER },
				[0, 1, 2, 3].map((i) => ({
					id: `b${i}`,
					type: 'paragraph',
					content: [{ kind: 'text', text: `t${i}` }]
				}))
			)
		).toBe(true);
		expect(updates()).toBe(1);
		expect(M.project(doc).children.map((b) => b.id)).toEqual(['b0', 'b1', 'b2', 'b3']);
		expect(M.blockText(doc, 'b2')).toBe('t2');
	});

	it('inserts at a clamped middle index preserving order', () => {
		const doc = newDoc();
		M.insertBlocks(doc, { parent: null, index: 0 }, [
			{ id: 'a', type: 'paragraph' },
			{ id: 'z', type: 'paragraph' }
		]);
		M.insertBlocks(doc, { parent: null, index: 1 }, [
			{ id: 'm1', type: 'paragraph' },
			{ id: 'm2', type: 'paragraph' }
		]);
		expect(M.project(doc).children.map((b) => b.id)).toEqual(['a', 'm1', 'm2', 'z']);
	});

	it('is all-or-nothing across the batch — dup vs live registry', () => {
		const doc = newDoc();
		M.insertBlock(doc, { parent: null, index: 0 }, { id: 'a', type: 'paragraph' });
		const updates = (() => {
			let n = 0;
			doc.on('update', () => n++);
			return () => n;
		})();
		expect(
			M.insertBlocks(doc, { parent: null, index: 1 }, [
				{ id: 'b', type: 'paragraph' },
				{ id: 'a', type: 'paragraph' }
			])
		).toBe(false);
		expect(updates()).toBe(0);
		expect(M.listBlockIds(doc)).toEqual(['a']);
	});

	it('rejects in-spec duplicate ids without writing', () => {
		const doc = newDoc();
		expect(
			M.insertBlocks(doc, { parent: null, index: 0 }, [
				{ id: 'x', type: 'paragraph', children: [{ id: 'y', type: 'paragraph' }] },
				{ id: 'y', type: 'paragraph' }
			])
		).toBe(false);
		expect(M.listBlockIds(doc)).toEqual([]);
	});

	it('refuses an unresolvable parent; empty batch is a no-op', () => {
		const doc = newDoc();
		const updates = (() => {
			let n = 0;
			doc.on('update', () => n++);
			return () => n;
		})();
		expect(
			M.insertBlocks(doc, { parent: 'ghost', index: 0 }, [{ id: 'b', type: 'paragraph' }])
		).toBe(false);
		expect(M.insertBlocks(doc, { parent: null, index: 0 }, [])).toBe(true);
		expect(updates()).toBe(0);
	});

	it('bulk insert projects identically to sequential insertBlock calls', () => {
		const spec = (i) => ({
			id: `b${i}`,
			type: i % 3 === 0 ? 'list' : 'paragraph',
			data: i % 2 ? { n: i } : undefined,
			content: [{ kind: 'text', text: `t${i}`, marks: i % 2 ? { bold: true } : undefined }],
			children:
				i === 1
					? [{ id: 'kid', type: 'paragraph', content: [{ kind: 'text', text: 'k' }] }]
					: undefined
		});
		const seq = newDoc();
		for (const i of [0, 1, 2, 3]) {
			seq.transact(() =>
				M.insertBlock(seq, { parent: null, index: Number.MAX_SAFE_INTEGER }, spec(i))
			);
		}
		const bulk = newDoc();
		M.insertBlocks(bulk, { parent: null, index: Number.MAX_SAFE_INTEGER }, [0, 1, 2, 3].map(spec));
		expect(M.project(bulk)).toEqual(M.project(seq));
	});
});
