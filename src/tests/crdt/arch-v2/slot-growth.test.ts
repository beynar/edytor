/**
 * Document growth guard (EW-02, over fork patch YP22). A block's place is
 * its home slot in its parent's sequence and a move is a move record: no
 * rank is written, so nothing grows with the number of inserts at one spot
 * (the retired `rank-growth` rows bounded the longest rank at 144 and 368
 * characters after 300 and 1,000 Enters; a slot has no length). These rows
 * measure the stored document and the slots and records it holds on the
 * same workloads, one replica, a seeded id stream: 300 and 1,000 Enters in
 * the middle of the document, 300 outline items typed with Tab and
 * Shift+Tab, and 3,000 one-step reorders of a 20-line list. The bounds sit
 * a little above what the committed code measures (in each row's comment);
 * a placement change must keep inside them, or say why a bound moves.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { loadDocument } from '$lib/crdt/index.js';
import { setDocRand } from '$lib/crdt/rand.js';
import { recordsOf } from '$lib/crdt/placement/model.js';
import { entriesOf, isBlockSlot } from '$lib/crdt/placement/slots.js';
import { mulberry32 } from '../harness/rng.js';
import { seedUpdate } from './replica-harness.js';
import { para } from './gesture-order-sweep.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** A fresh document of `seeds`, its id stream seeded (the same run every time). */
const open = (seeds) => {
	const document = loadDocument(seedUpdate(seeds), {
		actor: { id: 'ada' },
		history: { captureTimeout: 0 }
	});
	document.doc.clientID = 2 ** 26 + 1;
	setDocRand(document.doc, mulberry32(7));
	return document;
};

/** The root sequence's slots and live records, and the encoded document's bytes. */
const measure = (document) => {
	const doc = document.doc;
	const root = doc.get('blocks');
	const slots = entriesOf(doc, root).filter((e) => isBlockSlot(e.value)).length;
	const records = recordsOf(doc, root).length;
	const out = {
		slots,
		records,
		blocks: document.facade.order().length,
		bytes: document.encode().length
	};
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
			ok(ed.insertBlocks({ parent, index: index + 1 }, [{ id: nid, type: 'paragraph' }]));
		else ok(ed.insertBlocks({ parent, index, before: true }, [{ id: nid, type: 'paragraph' }]));
		ok(ed.insertText(nid, 0, `typed ${i}`));
	}
	return measure(document);
};

describe('EW-02: documents stay small under typing and reordering; one slot per block, no rank', () => {
	it('300 Enters in the middle of the document (in a line, at its end, at its start)', () => {
		const { slots, records, blocks, bytes } = enterWalk(300);
		// One home slot per top-level block, no record: nothing moved.
		expect(slots).toBe(blocks);
		expect(records).toBe(0);
		// Measured: see the design's "Prototype: measured" (116,114 bytes with ranks, 129-character ranks).
		expect(bytes).toBeLessThanOrEqual(100_000);
	});

	it('1,000 Enters in the middle of the document: the document grows with the text, not the Enters', () => {
		const at300 = enterWalk(300);
		const { slots, blocks, bytes } = enterWalk(1000);
		expect(slots).toBe(blocks);
		// A slot costs the same wherever it goes: the 1,000th Enter costs what the first did.
		expect(bytes - at300.bytes).toBeLessThanOrEqual(3.2 * at300.bytes);
		expect(bytes).toBeLessThanOrEqual(400_000);
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
			ok(ed.insertBlocks({ parent, index: index + 1 }, [{ id: nid, type: 'paragraph' }]));
			ok(ed.insertText(nid, 0, `item ${i}`));
			const key = rnd();
			if (key < 0.35) ok(ed.nestBlock(nid, last));
			else if (key < 0.6 && parent !== null) ok(ed.unNestBlock(nid));
			last = nid;
		}
		const { bytes } = measure(document);
		// Measured: 104,093 bytes with ranks (60-character ranks).
		expect(bytes).toBeLessThanOrEqual(100_000);
	});

	it('3,000 one-step reorders of a 20-line list', () => {
		const document = open(Array.from({ length: 20 }, (_, i) => para(`L${i}`)));
		const ed = document.facade;
		const rnd = mulberry32(3);
		let moves = 0;
		for (let i = 0; i < 3000; i++) {
			const order = ed.order();
			const id = order[Math.floor(rnd() * order.length)];
			const { index } = ed.positionOf(id);
			const up = rnd() < 0.5;
			if (up ? index === 0 : index === order.length - 1) continue;
			ok(ed.moveBlocks([id], { parent: null, index: up ? index - 1 : index + 1 }));
			moves++;
		}
		const { slots, records, bytes } = measure(document);
		// One home slot per block; one record per move until the purge compacts the lost ones.
		expect(slots).toBe(20);
		expect(records).toBe(moves);
		// Measured: 69,229 bytes with ranks (46 bytes a move).
		expect(bytes).toBeLessThanOrEqual(90_000);
	});
});
