/**
 * Rank and document growth guard (re-score 11, EW-02). Wave 13 ranked every
 * insert and move by its source and grew ranks and documents several times
 * faster (3,000 reorders of a 20-line list: a 10 MB document), so it was
 * not committed. These rows measure the committed ranking on the three
 * workloads that exposed it, one replica, a seeded rank stream: the longest
 * sibling rank and the encoded document after 300 Enters in the middle of
 * the document, 300 outline items typed with Tab and Shift+Tab, and 3,000
 * one-step reorders of a 20-line list, and the Enter walk at 1,000 steps
 * (FX-04: `rankBetween` kept descending past a locked prefix). The bounds
 * sit a little above what the committed code measures (in each row's
 * comment); a ranking change must keep inside them, or say why a bound moves.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { loadDocument } from '$lib/crdt/index.js';
import { setDocRand } from '$lib/crdt/rand.js';
import { decodeRank, encodeRank, rankBetween } from '$lib/crdt/placement/rank.js';
import { mulberry32 } from '../harness/rng.js';
import { seedUpdate } from './replica-harness.js';
import { para } from './gesture-order-sweep.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** A fresh document of `seeds`, its rank stream seeded (the same run every time). */
const open = (seeds) => {
	const document = loadDocument(seedUpdate(seeds), {
		actor: { id: 'ada' },
		history: { captureTimeout: 0 }
	});
	document.doc.clientID = 2 ** 26 + 1;
	setDocRand(document.doc, mulberry32(7));
	return document;
};

/** The longest rank among every block's slot, and the encoded document's bytes. */
const measure = (document) => {
	const ed = document.facade;
	const ranks = ed.order().map((id) => ed.slotOf(id).rank.length);
	const out = { rank: Math.max(...ranks), bytes: document.encode().length };
	document.destroy();
	return out;
};

/** `steps` Enters in the middle of a 20-line document (in a line, at its end, at its start). */
const enterWalk = (steps) => {
	const document = open(Array.from({ length: 20 }, (_, i) => para(`line ${i}`)));
	const ed = document.facade;
	const rnd = mulberry32(11);
	for (let i = 0; i < steps; i++) {
		const order = ed.order();
		const id = order[Math.floor(order.length / 2) + Math.floor(rnd() * 5) - 2];
		const length = ed.blockText(id).length;
		const { parent, index } = ed.positionOf(id);
		const nid = `N${i}`;
		const kind = rnd();
		// Enter in the line: a split at its middle; at its end or start: a new line beside it.
		if (kind < 0.4 && length > 1) ok(ed.splitBlock(id, length >> 1, nid));
		else if (kind < 0.8)
			ok(ed.insertBlock({ parent, index: index + 1 }, { id: nid, type: 'paragraph' }));
		else ok(ed.insertBlock({ parent, index, before: true }, { id: nid, type: 'paragraph' }));
		ok(ed.insertText(nid, 0, `typed ${i}`));
	}
	return measure(document);
};

const seg = (...vs) => encodeRank(vs.map((v) => ({ v, t: 1 })));

describe('FX-04: a rank stops descending once its prefix is below the right bound', () => {
	it('rankBetween([100,5,7], [100,6,3]) stops at the first level its own tie fits (P7)', () => {
		const left = seg(100, 5, 7);
		const right = seg(100, 6, 3);
		const rank = rankBetween(left, right, 9, () => 0);
		// (5, tie 9) sorts after (5, tie 1) and before (6, …): two segments
		// (three, [100, 5, 8], before P7).
		expect(decodeRank(rank).map((s) => s.v)).toEqual([100, 5]);
		expect(left < rank && rank < right).toBe(true);
	});

	it("locked below the right bound at the left bound's last level: one level deeper, no more", () => {
		const rank = rankBetween(seg(100, 5), seg(100, 6, 3, 9), 9, () => 0);
		// Its own tie fits at that level ([100, 5, 0] before P7).
		expect(decodeRank(rank).map((s) => s.v)).toEqual([100, 5]);
	});
});

describe('EW-02: ranks and documents stay small under typing and reordering', () => {
	it('300 Enters in the middle of the document (in a line, at its end, at its start)', () => {
		const { rank, bytes } = enterWalk(300);
		// Measured: 129 characters, 116,114 bytes (P7, schema generation 5;
		// 256, 133,150 before it; 240, 132,647 before the block runs of
		// `order.insert.run`; before FX-04: 432, 138,924). With a 53-bit
		// client id (this one has 27 bits): 165 characters (256 before P7).
		expect(rank).toBeLessThanOrEqual(144);
		expect(bytes).toBeLessThanOrEqual(125_000);
	});

	it('1,000 Enters in the middle of the document: ranks grow slower than the Enters', () => {
		const at300 = enterWalk(300).rank;
		const { rank, bytes } = enterWalk(1000);
		// Measured: 342 characters, 484,181 bytes (P7; 576, 604,280 before
		// it; 592, 611,228 before `order.insert.run`; before FX-04: 896,
		// 752 KB). With a 53-bit client id: 446 characters (576 before P7):
		// the ties a run keeps on every level are most of a long rank.
		// Enters concentrated at one spot still descend about one level (a few
		// characters since P7, 16 before) per 32 Enters, as a gap halves at
		// each insert there, so the ratio is bounded, not 2.
		expect(rank).toBeLessThanOrEqual(2.75 * at300);
		expect(rank).toBeLessThanOrEqual(368);
		expect(bytes).toBeLessThanOrEqual(500_000);
	});

	it('300 outline items typed with Enter, Tab and Shift+Tab', () => {
		const document = open([para('outline')]);
		const ed = document.facade;
		const rnd = mulberry32(12);
		let last = 'outline';
		for (let i = 0; i < 300; i++) {
			const nid = `I${i}`;
			const { parent, index } = ed.positionOf(last);
			// Enter at the end of the newest line: a new line after it.
			ok(ed.insertBlock({ parent, index: index + 1 }, { id: nid, type: 'paragraph' }));
			ok(ed.insertText(nid, 0, `item ${i}`));
			const key = rnd();
			if (key < 0.35) ok(ed.nestBlock(nid, last));
			else if (key < 0.6 && parent !== null) ok(ed.unNestBlock(nid));
			last = nid;
		}
		const { rank, bytes } = measure(document);
		// Measured: 60 characters, 104,093 bytes (P7; 112, 112,451 before it;
		// 96, 108,109 before `order.insert.run`: a run opens one segment
		// after an item).
		expect(rank).toBeLessThanOrEqual(72);
		expect(bytes).toBeLessThanOrEqual(110_000);
	});

	it('3,000 one-step reorders of a 20-line list', () => {
		const document = open(Array.from({ length: 20 }, (_, i) => para(`L${i}`)));
		const ed = document.facade;
		const rnd = mulberry32(3);
		for (let i = 0; i < 3000; i++) {
			const order = ed.order();
			const id = order[Math.floor(rnd() * order.length)];
			const { index } = ed.positionOf(id);
			const up = rnd() < 0.5;
			if (up ? index === 0 : index === order.length - 1) continue;
			ok(ed.moveBlock(id, { parent: null, index: up ? index - 1 : index + 1 }));
		}
		const { rank, bytes } = measure(document);
		// Measured: 23 characters (one rank of two segments, 32 in the format
		// before P7; the others one, 13), 69,229 bytes (16, 70,647 before P7;
		// 151,975 before the history kept 200 steps, P6; before FX-04: 32;
		// wave 13's source-ranked moves: 10 MB).
		expect(rank).toBeLessThanOrEqual(24);
		expect(bytes).toBeLessThanOrEqual(75_000);
	});
});
