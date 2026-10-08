/**
 * Scale timings (CC-05) — the wall-clock half of the gate rows that now
 * count operations instead:
 *
 * - P1 scale (`src/tests/crdt/arch-v2/facade-scale.test.ts`): document work at
 *   1,000 and 5,000 blocks (construct, load, keystroke, remote keystroke,
 *   Enter, Backspace, bold, a range delete across 40 blocks, a keystroke in
 *   a merged block), 2,000 inserts received as one batch and one by one, and
 *   a 5,000-keystroke history.
 * - F-O5 (`range-delete.test.ts`, `index-fold-report.test.ts`): a range
 *   delete and a selected-block delete over 1,000 paragraphs, and 1,000
 *   inserts in one transaction against 1,000 separate ones.
 *
 * The gate rows assert what a machine cannot change (folds, their input,
 * recomputes, items read: deterministic); these numbers are the machine's.
 * `budgets` are the bounds the rows held before CC-05 (ms, an order of
 * magnitude above the medians measured then): `over` lists the timings past
 * theirs, reported, never failed.
 *
 * Facade imports go through jiti, as `baseline.js` does, so the bench
 * measures the working-tree TypeScript. The index's self-checks are off
 * (`indexChecks` defaults to off outside the vitest lanes).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
const vitestDir = req.resolve('vitest/package.json').replace(/\/package\.json$/, '');
const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
const jiti = createJiti(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const { Y } = await jiti.import(`${here}../../src/lib/crdt/engine.js`);
const { bindCrdt, createDocument, loadDocument } = await jiti.import(
	`${here}../../src/lib/crdt/index.ts`
);
const { bindEdytorDoc } = await jiti.import(`${here}../../src/lib/crdt/edytor-doc.ts`);

const crdt = bindCrdt(Y);
const E = bindEdytorDoc(Y);
const REMOTE = Object.freeze({ bench: 'remote' });

/** The bounds the gate rows held before CC-05 (ms). */
export const budgets = {
	construct5k: 8000,
	keystroke: 15,
	remoteKeystroke: 15,
	enter: 40,
	backspace: 20,
	bold: 30,
	rangeDelete: 50,
	blockDelete: 50,
	batch2000: 4000,
	historyOp: 40,
	encodeLoad5000: 3000,
	/** One transaction of 1,000 inserts against 1,000 transactions (a ratio). */
	batchedOverSeparate: 2.5
};

const blocks = (n) =>
	Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `block number ${i} with some text` }]
	}));
const time = (f) => {
	const s = performance.now();
	const r = f();
	return [r, performance.now() - s];
};
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 100) / 100;
const captured = (doc, fn) => {
	const sv = Y.encodeStateVector(doc);
	fn();
	return Y.encodeStateAsUpdate(doc, sv);
};

const atSize = (n) => {
	const [doc, construct] = time(() => createDocument({ value: { children: blocks(n) } }));
	const seed = doc.encode();
	const [peer, load] = time(() => loadDocument(seed));
	const ed = doc.facade;
	const mid = `b${n >> 1}`;
	const ks = [];
	const updates = [];
	for (let i = 0; i < 21; i++) {
		let t = 0;
		updates.push(
			captured(doc.doc, () => {
				[, t] = time(() => (ed.insertText(mid, 3 + i, 'k'), ed.blockText(mid)));
			})
		);
		ks.push(t);
	}
	const rk = updates.map(
		(u) => time(() => (crdt.sync.applyRemote(peer.doc, u, REMOTE), peer.facade.blockText(mid)))[1]
	);
	const en = Array.from(
		{ length: 5 },
		(_, i) => time(() => ed.splitBlock(`b${10 + i}`, 2, `e${i}`))[1]
	);
	const bs = Array.from({ length: 5 }, (_, i) => time(() => ed.deleteText(`b${100 + i}`, 0, 1))[1]);
	const fm = Array.from(
		{ length: 5 },
		(_, i) => time(() => ed.setMark(`b${200 + i}`, 0, 3, 'bold', true))[1]
	);
	const [, rd] = time(() =>
		ed.deleteRange({ block: 'b300', offset: 2 }, { block: 'b340', offset: 2 })
	);
	ed.mergeBackward('b601');
	const mergedKs = med(
		Array.from({ length: 5 }, (_, i) => time(() => ed.insertText('b600', 40 + i, 'm'))[1])
	);
	doc.destroy();
	peer.destroy();
	return {
		constructMs: round(construct),
		loadMs: round(load),
		keystrokeMs: round(med(ks)),
		remoteKeystrokeMs: round(med(rk)),
		enterMs: round(med(en)),
		backspaceMs: round(med(bs)),
		boldMs: round(med(fm)),
		rangeDelete40Ms: round(rd),
		mergedKeystrokeMs: round(mergedKs)
	};
};

const batch2000 = () => {
	const doc = createDocument({ value: { children: blocks(1000) } });
	const seed = doc.encode();
	const ups = [];
	const [, author] = time(() => {
		for (let i = 0; i < 2000; i++)
			ups.push(captured(doc.doc, () => doc.facade.insertText(`b${i % 1000}`, 0, 'x')));
	});
	const batchPeer = loadDocument(seed);
	const [, batch] = time(() => crdt.sync.applyRemote(batchPeer.doc, Y.mergeUpdates(ups), REMOTE));
	const streamPeer = loadDocument(seed);
	const per = ups
		.slice(0, 500)
		.map((u) => time(() => crdt.sync.applyRemote(streamPeer.doc, u, REMOTE))[1]);
	for (const d of [doc, batchPeer, streamPeer]) d.destroy();
	return {
		authorMs: round(author),
		batchMs: round(batch),
		perOpFirstMs: round(med(per.slice(0, 10))),
		perOpLastMs: round(med(per.slice(490)))
	};
};

const history5000 = () => {
	const doc = createDocument({ value: { children: blocks(10) }, history: { captureTimeout: 0 } });
	const seed = doc.encode();
	const ups = [];
	for (let i = 0; i < 5000; i++)
		ups.push(captured(doc.doc, () => doc.facade.insertText('b1', 1, 'y')));
	const peer = loadDocument(seed);
	crdt.sync.applyRemote(peer.doc, Y.mergeUpdates(ups.slice(0, 4999)), REMOTE);
	const [, remote] = time(() => crdt.sync.applyRemote(peer.doc, ups[4999], REMOTE));
	const [, enter] = time(() => doc.facade.splitBlock('b1', 1, 'zz'));
	const [, del] = time(() => doc.facade.deleteText('b1', 0, 1));
	const [, undo] = time(() => doc.history.undo());
	const [saved, enc] = time(() => doc.encode());
	const [loaded, load] = time(() => loadDocument(saved));
	for (const d of [doc, peer, loaded]) d.destroy();
	return {
		remoteKeystrokeMs: round(remote),
		enterMs: round(enter),
		deleteMs: round(del),
		undoMs: round(undo),
		encodeMs: round(enc),
		bytes: saved.length,
		loadMs: round(load)
	};
};

/** F-O5 (document half): `n` paragraphs, one range delete / one block delete. */
const deletes = (n) => {
	const many = () =>
		createDocument({
			value: {
				children: Array.from({ length: n }, (_, i) => ({
					id: `p${i}`,
					type: 'paragraph',
					content: [{ text: `paragraph ${i}` }]
				}))
			}
		}).facade;
	const range = many();
	range.toJSON();
	const [, rangeMs] = time(() =>
		range.apply(
			range.prepare.deleteRange({ block: 'p0', offset: 1 }, { block: `p${n - 1}`, offset: 1 })
		)
	);
	const blocksDoc = many();
	blocksDoc.toJSON();
	const ids = blocksDoc.childrenIds(null).slice(1);
	const [, blockMs] = time(() => blocksDoc.apply(blocksDoc.prepare.deleteBlocks(ids)));
	return { rangeDeleteMs: round(rangeMs), blockDeleteMs: round(blockMs) };
};

/** F-O5 (linearity half): 1,000 inserts in one transaction against 1,000 transactions. */
const batched1000 = () => {
	const run = (n, oneTx) => {
		const doc = new Y.Doc();
		doc.clientID = 31;
		const ed = E.create(doc);
		ed.init({ content: [{ id: 'r0', type: 'paragraph', content: [{ kind: 'text', text: 'x' }] }] });
		const body = () => {
			for (let i = 0; i < n; i++)
				ed.insertBlock(
					{ parent: null, index: i + 1 },
					{ id: `b${i}`, type: 'paragraph', content: [{ kind: 'text', text: 'hello' }] }
				);
		};
		return time(() => (oneTx ? ed.transact(body) : body()))[1];
	};
	run(200, true);
	run(200, false);
	const best = (oneTx) => Math.min(run(1000, oneTx), run(1000, oneTx));
	const separate = best(false);
	const batched = best(true);
	return {
		separateMs: round(separate),
		batchedMs: round(batched),
		ratio: round(batched / separate)
	};
};

export const scale = () => {
	const sizes = { 1000: atSize(1000), 5000: atSize(5000) };
	const result = {
		sizes,
		batch2000: batch2000(),
		history5000: history5000(),
		deletes1000: (deletes(100), deletes(1000)), // the first warms the JIT
		batched1000: batched1000(),
		budgets
	};
	const over = [];
	const check = (name, value, budget) => {
		if (value >= budget) over.push(`${name}: ${value} ≥ ${budget}`);
	};
	for (const [n, s] of Object.entries(sizes)) {
		if (n === '5000') check('5000: construct', s.constructMs, budgets.construct5k);
		check(`${n}: keystroke`, s.keystrokeMs, budgets.keystroke);
		check(`${n}: remote keystroke`, s.remoteKeystrokeMs, budgets.remoteKeystroke);
		check(`${n}: Enter`, s.enterMs, budgets.enter);
		check(`${n}: Backspace`, s.backspaceMs, budgets.backspace);
		check(`${n}: bold`, s.boldMs, budgets.bold);
		check(`${n}: range delete (40 blocks)`, s.rangeDelete40Ms, budgets.rangeDelete);
		check(`${n}: keystroke in a merged block`, s.mergedKeystrokeMs, budgets.keystroke);
	}
	check('batch 2000', result.batch2000.batchMs, budgets.batch2000);
	check('per-op receive at 490..500', result.batch2000.perOpLastMs, budgets.remoteKeystroke);
	const h = result.history5000;
	for (const k of ['remoteKeystrokeMs', 'enterMs', 'deleteMs', 'undoMs'])
		check(`history 5000: ${k}`, h[k], budgets.historyOp);
	check('history 5000: encode + load', round(h.encodeMs + h.loadMs), budgets.encodeLoad5000);
	check('F-O5 range delete', result.deletes1000.rangeDeleteMs, budgets.rangeDelete);
	check('F-O5 block delete', result.deletes1000.blockDeleteMs, budgets.blockDelete);
	check('F-O5 batched / separate', result.batched1000.ratio, budgets.batchedOverSeparate);
	result.over = over;
	return result;
};
