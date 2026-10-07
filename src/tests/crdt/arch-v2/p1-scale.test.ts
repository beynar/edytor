/**
 * arch-v2 phase 2 P1.1 — the native review's scale probes
 * (`review-probes/scale.test.ts`, `scale2.test.ts`) re-targeted at arch-v2:
 * document work at 1,000 and 5,000 blocks through the facade, remote
 * admission of one keystroke, a long history, and a keystroke in a block
 * that was merged before.
 *
 * CC-05: the rows count operations, never a wall clock, so they hold on any
 * machine under any load. What they count is the index's work for each
 * operation (`runsView.debug`: fold passes, the `(type, key)` pairs and the
 * structs they folded, the blocks recomputed, the items range reads walked),
 * and the contract is that a local edit's work does not grow with the
 * document or its history: five times the blocks (or five hundred times the
 * history) cost the same counts. The timings these rows asserted before are
 * `bench:crdt`'s `scale` workload (`pnpm bench:scale`).
 *
 * Not covered here: these counters see only the index. The timings also
 * covered remote admission (`applyRemote`'s checks), the engine's
 * integration, the undo manager's cost, construction and encode/load; their
 * scaling is now checked only by `pnpm bench:scale`, which reports and fails
 * nothing (a follow-up in docs/production-readiness-plan-2026-10.md, WU-09).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { indexChecks } from '../../../lib/crdt/text/runs.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { REMOTE, crdt } from './p1-harness.js';

// Counts: the index's per-fold self-checks (a rebuild each) would be counted too.
const checks = indexChecks.on;
beforeAll(() => void (indexChecks.on = false));
afterAll(() => void (indexChecks.on = checks));

const blocks = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ text: `block number ${i} with some text` }]
	}));

type Work = { folds: number; pairs: number; structs: number; recomputes: number; items: number };

/** Read every block's runs, as a view's cells do: what is stale recomputes. */
const readAll = (facade) => {
	for (const id of facade.listBlockIds()) facade.runs(id);
};

/**
 * The index's work for `fn` on `facade` (its counters reset first), and for
 * reading every block's runs after it (`read`; a view's patch reads no more):
 * every block `fn` left stale recomputes and is counted.
 */
const work = (facade, fn: () => void, read = true): Work => {
	const { debug } = facade.runsView;
	debug.reset();
	fn();
	if (read) readAll(facade);
	return {
		folds: debug.folds,
		pairs: debug.foldedPairs,
		structs: debug.foldedStructs,
		recomputes: debug.recomputes,
		items: debug.itemsWalked
	};
};
const sum = (ws: Work[]): Work =>
	ws.reduce(
		(a, w) => ({
			folds: a.folds + w.folds,
			pairs: a.pairs + w.pairs,
			structs: a.structs + w.structs,
			recomputes: a.recomputes + w.recomputes,
			items: a.items + w.items
		}),
		{ folds: 0, pairs: 0, structs: 0, recomputes: 0, items: 0 }
	);

/** One captured update per call of `fn`. */
const captured = (doc, fn: () => void): Uint8Array => {
	const sv = Y.encodeStateVector(doc);
	fn();
	return Y.encodeStateAsUpdate(doc, sv);
};

/** Each operation of the size row, its work summed over its samples. */
const atSize = (n: number) => {
	const doc = createDocument({ value: { children: blocks(n) } });
	const peer = loadDocument(doc.encode());
	const ed = doc.facade;
	const mid = `b${n >> 1}`;
	readAll(ed);
	readAll(peer.facade);
	const ks: Work[] = [];
	const updates: Uint8Array[] = [];
	for (let i = 0; i < 21; i++)
		updates.push(
			captured(doc.doc, () =>
				ks.push(work(ed, () => (ed.insertText(mid, 3 + i, 'k'), ed.blockText(mid))))
			)
		);
	// Admission, integration and the index fold (a read forces it).
	const rk = updates.map((u) =>
		work(peer.facade, () => {
			crdt.sync.applyRemote(peer.doc, u, REMOTE);
			peer.facade.blockText(mid);
		})
	);
	expect(peer.facade.blockText(mid)).toBe(ed.blockText(mid));
	const en = Array.from({ length: 5 }, (_, i) =>
		work(ed, () => ed.splitBlock(`b${10 + i}`, 2, `e${i}`))
	);
	const bs = Array.from({ length: 5 }, (_, i) =>
		work(ed, () => ed.deleteText(`b${100 + i}`, 0, 1))
	);
	const fm = Array.from({ length: 5 }, (_, i) =>
		work(ed, () => ed.setMark(`b${200 + i}`, 0, 3, 'bold', true))
	);
	const rd = work(ed, () =>
		ed.deleteRange({ block: 'b300', offset: 2 }, { block: 'b340', offset: 2 })
	);
	ed.mergeBackward('b601');
	const mk = Array.from({ length: 5 }, (_, i) =>
		work(ed, () => ed.insertText('b600', 40 + i, 'm'))
	);
	expect(ed.blockText('b600')).toContain('mmmmm');
	doc.destroy();
	peer.destroy();
	return {
		keystroke: sum(ks),
		'remote keystroke': sum(rk),
		Enter: sum(en),
		Backspace: sum(bs),
		bold: sum(fm),
		'range delete across 40 blocks': rd,
		'keystroke in a merged block': sum(mk)
	};
};

/** Every count of `large` (but `except`) at most `small`'s: the work did not grow. */
const same = (label: string, small: Work, large: Work, except: (keyof Work)[] = []) => {
	expect(small.folds, `${label}: folds`).toBeGreaterThan(0);
	for (const k of Object.keys(small) as (keyof Work)[])
		if (!except.includes(k)) expect(large[k], `${label}: ${k}`).toBeLessThanOrEqual(small[k]);
};

describe('P1 scale — document work at 1k / 5k blocks (review-probes/scale)', () => {
	it('keystroke, remote keystroke, Enter, Backspace, bold, range delete: the same work at 5,000 blocks as at 1,000', () => {
		const small = atSize(1000);
		const large = atSize(5000);
		for (const op of Object.keys(small)) same(op, small[op], large[op]);
	});

	it('1k blocks: 2,000 local inserts received as one merged batch and one by one', () => {
		const doc = createDocument({ value: { children: blocks(1000) } });
		const seed = doc.encode();
		const ups: Uint8Array[] = [];
		for (let i = 0; i < 2000; i++)
			ups.push(captured(doc.doc, () => doc.facade.insertText(`b${i % 1000}`, 0, 'x')));
		const batchPeer = loadDocument(seed);
		const batch = work(
			batchPeer.facade,
			() => crdt.sync.applyRemote(batchPeer.doc, Y.mergeUpdates(ups), REMOTE),
			false
		);
		const streamPeer = loadDocument(seed);
		const per = ups.map((u) =>
			work(streamPeer.facade, () => crdt.sync.applyRemote(streamPeer.doc, u, REMOTE), false)
		);
		// One merged batch is one fold, whose input is at most what the
		// separate updates fold together; the 2,000th update folds what the
		// first did (the receiver's history does not grow its work).
		expect(batch.folds).toBe(1);
		expect(batch.pairs).toBeLessThanOrEqual(sum(per).pairs);
		same('per-op receive at 1990..2000', sum(per.slice(0, 10)), sum(per.slice(1990)));
		expect(batchPeer.facade.blockText('b0')).toBe('xxblock number 0 with some text');
		for (const d of [doc, batchPeer, streamPeer]) d.destroy();
	});

	it('10 blocks + a 5,000-keystroke history: remote keystroke, Enter, delete, undo do the work of a 10-keystroke history', () => {
		const history = (n: number) => {
			const doc = createDocument({
				value: { children: blocks(10) },
				history: { captureTimeout: 0 }
			});
			const seed = doc.encode();
			const ups: Uint8Array[] = [];
			for (let i = 0; i < n; i++)
				ups.push(captured(doc.doc, () => doc.facade.insertText('b1', 1, 'y')));
			const peer = loadDocument(seed);
			crdt.sync.applyRemote(peer.doc, Y.mergeUpdates(ups.slice(0, n - 1)), REMOTE);
			readAll(doc.facade);
			readAll(peer.facade);
			const counts = {
				'remote keystroke': work(peer.facade, () => {
					crdt.sync.applyRemote(peer.doc, ups[n - 1], REMOTE);
					peer.facade.blockText('b1');
				}),
				Enter: work(doc.facade, () => doc.facade.splitBlock('b1', 1, 'zz')),
				delete: work(doc.facade, () => doc.facade.deleteText('b1', 0, 1)),
				undo: work(doc.facade, () => doc.history.undo())
			};
			const loaded = loadDocument(doc.encode());
			expect(loaded.facade.toJSON()).toEqual(doc.facade.toJSON());
			for (const d of [doc, peer, loaded]) d.destroy();
			return counts;
		};
		const short = history(10);
		const long = history(5000);
		// Not the items read: b1 holds 4,990 more characters, one item each (each
		// keystroke went before the last), and a read of b1 walks them all.
		for (const op of Object.keys(short)) same(op, short[op], long[op], ['items']);
	});
});
