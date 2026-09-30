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
import { seedUpdate } from './p1-harness.js';
import { para } from './cw01-sweep.js';

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
	it('rankBetween([100,5,7], [100,6,3]) is three segments, between both', () => {
		const left = seg(100, 5, 7);
		const right = seg(100, 6, 3);
		const rank = rankBetween(left, right, 9, () => 0);
		expect(decodeRank(rank).map((s) => s.v)).toEqual([100, 5, 8]);
		expect(left < rank && rank < right).toBe(true);
	});

	it("locked below the right bound at the left bound's last level: one level deeper, no more", () => {
		const rank = rankBetween(seg(100, 5), seg(100, 6, 3, 9), 9, () => 0);
		expect(decodeRank(rank).map((s) => s.v)).toEqual([100, 5, 0]);
	});
});

describe('EW-02: ranks and documents stay small under typing and reordering', () => {
	it('300 Enters in the middle of the document (in a line, at its end, at its start)', () => {
		const { rank, bytes } = enterWalk(300);
		// Measured: 240 characters, 132,647 bytes (before FX-04: 432, 138,924).
		expect(rank).toBeLessThanOrEqual(256);
		expect(bytes).toBeLessThanOrEqual(140_000);
	});

	it('1,000 Enters in the middle of the document: ranks grow slower than the Enters', () => {
		const at300 = enterWalk(300).rank;
		const { rank, bytes } = enterWalk(1000);
		// Measured: 592 characters, 611,228 bytes (before FX-04: 896, 752 KB).
		// Enters concentrated at one spot still descend about one level (16
		// characters) per 32 Enters, as a gap halves at each insert there
		// (3,000 Enters: 1,616 characters), so the ratio is bounded, not 2.
		expect(rank).toBeLessThanOrEqual(2.5 * at300);
		expect(rank).toBeLessThanOrEqual(624);
		expect(bytes).toBeLessThanOrEqual(640_000);
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
		// Measured: 96 characters, 108,109 bytes.
		expect(rank).toBeLessThanOrEqual(112);
		expect(bytes).toBeLessThanOrEqual(120_000);
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
		// Measured: 16 characters, 151,975 bytes (before FX-04: 32; wave 13's source-ranked moves: 10 MB).
		expect(rank).toBeLessThanOrEqual(32);
		expect(bytes).toBeLessThanOrEqual(165_000);
	});
});
