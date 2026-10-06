/**
 * arch-v2 phase 2 P1.1 — the native review's scale probes
 * (`review-probes/scale.test.ts`, `scale2.test.ts`) re-targeted at arch-v2:
 * document work at 1,000 and 5,000 blocks through the facade, remote
 * admission of one keystroke, a long history, and a keystroke in a block
 * that was merged before.
 *
 * The native probes only printed timings; these rows keep the timings as
 * regression bounds. Budgets are generous (a loaded CI machine, one sample
 * set per row) and far below what an editor could not live with — they
 * catch an order-of-magnitude regression, not noise. `P1_SCALE_OUT=<file>`
 * writes the measured numbers as JSON (the ledger records them).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { indexChecks } from '../../../lib/crdt/text/runs.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { REMOTE, crdt } from './p1-harness.js';

// Timings: the index's per-fold self-checks (a rebuild each) would be measured too.
const checks = indexChecks.on;
beforeAll(() => void (indexChecks.on = false));
afterAll(() => void (indexChecks.on = checks));

const blocks = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `block number ${i} with some text` }]
	}));
const time = <T>(f: () => T): [T, number] => {
	const s = performance.now();
	const r = f();
	return [r, performance.now() - s];
};
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 100) / 100;

const out: Record<string, number | number[]> = {};
const record = (k: string, v: number | number[]) =>
	(out[k] = Array.isArray(v) ? v.map(round) : round(v));

/** One captured update per call of `fn`. */
const captured = (doc, fn: () => void): Uint8Array => {
	const sv = Y.encodeStateVector(doc);
	fn();
	return Y.encodeStateAsUpdate(doc, sv);
};

/** Budgets (ms) — an order of magnitude above the measured medians. */
const BUDGET = {
	construct5k: 8000,
	keystroke: 15,
	remoteKeystroke: 15,
	enter: 40,
	backspace: 20,
	bold: 30,
	rangeDelete: 50, // F-O5
	batch2000: 4000,
	historyOp: 40,
	encodeLoad5000: 3000
};

describe('P1 scale — document work at 1k / 5k blocks (review-probes/scale)', () => {
	for (const n of [1000, 5000]) {
		it(`${n} blocks: construct, keystroke, remote keystroke, Enter, Backspace, bold, range delete`, () => {
			const [doc, construct] = time(() => createDocument({ value: { children: blocks(n) } }));
			record(`${n}: construct ms`, construct);
			const seed = doc.encode();
			const [peer, load] = time(() => loadDocument(seed));
			record(`${n}: load ms`, load);
			const ed = doc.facade;
			const mid = `b${n >> 1}`;

			const ks: number[] = [];
			const updates: Uint8Array[] = [];
			for (let i = 0; i < 21; i++) {
				let t = 0;
				updates.push(
					captured(
						doc.doc,
						() => ([, t] = time(() => (ed.insertText(mid, 3 + i, 'k'), ed.blockText(mid))))
					)
				);
				ks.push(t);
			}
			record(`${n}: local keystroke median ms`, med(ks));
			// Admission, integration and the index fold (a read forces it).
			const rk = updates.map(
				(u) =>
					time(() => (crdt.sync.applyRemote(peer.doc, u, REMOTE), peer.facade.blockText(mid)))[1]
			);
			expect(peer.facade.blockText(mid)).toBe(ed.blockText(mid));
			record(`${n}: remote keystroke admit+apply median ms`, med(rk));
			const en = Array.from(
				{ length: 5 },
				(_, i) => time(() => ed.splitBlock(`b${10 + i}`, 2, `e${i}`))[1]
			);
			record(`${n}: local Enter (split) median ms`, med(en));
			const bs = Array.from(
				{ length: 5 },
				(_, i) => time(() => ed.deleteText(`b${100 + i}`, 0, 1))[1]
			);
			record(`${n}: local Backspace median ms`, med(bs));
			const fm = Array.from(
				{ length: 5 },
				(_, i) => time(() => ed.setMark(`b${200 + i}`, 0, 3, 'bold', true))[1]
			);
			record(`${n}: local bold median ms`, med(fm));
			const [, rd] = time(() =>
				ed.deleteRange({ block: `b${300}`, offset: 2 }, { block: `b${340}`, offset: 2 })
			);
			record(`${n}: range delete across 40 blocks ms`, rd);
			const mergedKs = (() => {
				ed.mergeBackward('b601');
				return med(
					Array.from({ length: 5 }, (_, i) => time(() => ed.insertText('b600', 40 + i, 'm'))[1])
				);
			})();
			record(`${n}: keystroke in a merged block median ms`, mergedKs);

			if (n === 5000) expect(construct).toBeLessThan(BUDGET.construct5k);
			expect(med(ks)).toBeLessThan(BUDGET.keystroke);
			expect(med(rk)).toBeLessThan(BUDGET.remoteKeystroke);
			expect(med(en)).toBeLessThan(BUDGET.enter);
			expect(med(bs)).toBeLessThan(BUDGET.backspace);
			expect(med(fm)).toBeLessThan(BUDGET.bold);
			expect(rd).toBeLessThan(BUDGET.rangeDelete);
			expect(mergedKs).toBeLessThan(BUDGET.keystroke);
			expect(ed.blockText('b600')).toContain('mmmmm');
			doc.destroy();
			peer.destroy();
		});
	}

	it('1k blocks: 2,000 local inserts received as one merged batch and one by one', () => {
		const doc = createDocument({ value: { children: blocks(1000) } });
		const seed = doc.encode();
		const ups: Uint8Array[] = [];
		const [, author] = time(() => {
			for (let i = 0; i < 2000; i++)
				ups.push(captured(doc.doc, () => doc.facade.insertText(`b${i % 1000}`, 0, 'x')));
		});
		record('1k: author 2000 local inserts total ms', author);
		const batchPeer = loadDocument(seed);
		const [, batch] = time(() => crdt.sync.applyRemote(batchPeer.doc, Y.mergeUpdates(ups), REMOTE));
		record('1k: receive 2000 inserts as one batch ms', batch);
		const streamPeer = loadDocument(seed);
		const per = ups
			.slice(0, 500)
			.map((u) => time(() => crdt.sync.applyRemote(streamPeer.doc, u, REMOTE))[1]);
		record('1k: per-op receive ms at 0..10 / 490..500', [
			med(per.slice(0, 10)),
			med(per.slice(490))
		]);
		expect(batch).toBeLessThan(BUDGET.batch2000);
		expect(med(per.slice(490))).toBeLessThan(BUDGET.remoteKeystroke);
		expect(batchPeer.facade.blockText('b0')).toBe('xxblock number 0 with some text');
		for (const d of [doc, batchPeer, streamPeer]) d.destroy();
	});

	it('10 blocks + a 5,000-keystroke history: remote keystroke, Enter, delete, undo, encode/load', () => {
		const doc = createDocument({ value: { children: blocks(10) }, history: { captureTimeout: 0 } });
		const seed = doc.encode();
		const ups: Uint8Array[] = [];
		for (let i = 0; i < 5000; i++)
			ups.push(captured(doc.doc, () => doc.facade.insertText('b1', 1, 'y')));
		const peer = loadDocument(seed);
		crdt.sync.applyRemote(peer.doc, Y.mergeUpdates(ups.slice(0, 4999)), REMOTE);
		const [, remote] = time(() => crdt.sync.applyRemote(peer.doc, ups[4999], REMOTE));
		record('history 5000: remote keystroke ms', remote);
		const [, enter] = time(() => doc.facade.splitBlock('b1', 1, 'zz'));
		record('history 5000: local Enter ms', enter);
		const [, del] = time(() => doc.facade.deleteText('b1', 0, 1));
		record('history 5000: local delete ms', del);
		const [, undo] = time(() => doc.history.undo());
		record('history 5000: undo ms', undo);
		const [saved, enc] = time(() => doc.encode());
		const [loaded, load] = time(() => loadDocument(saved));
		record('history 5000: encode ms / bytes / load ms', [enc, saved.length, load]);
		for (const t of [remote, enter, del, undo]) expect(t).toBeLessThan(BUDGET.historyOp);
		expect(enc + load).toBeLessThan(BUDGET.encodeLoad5000);
		expect(loaded.facade.toJSON()).toEqual(doc.facade.toJSON());
		for (const d of [doc, peer, loaded]) d.destroy();
		if (process.env.P1_SCALE_OUT)
			writeFileSync(process.env.P1_SCALE_OUT, JSON.stringify(out, null, 1));
	});
});
