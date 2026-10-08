/**
 * H5 (CRDT study 2026-10; contract rows `mark.*`): paired marks — the
 * Peritext cases (Litt, Lim, Kleppmann, van Hardenberg, "Peritext: A CRDT
 * for Collaborative Rich Text Editing", CSCW 2022, §2 and §4) on two and
 * three replicas, every swept client-id pair, every delivery order (the
 * §8 harness: replicas, observers in both orders, reloads).
 *
 * Each expectation is the paper's intended outcome, written here, never
 * read back from the implementation.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { clientPairs, clientTriples, converge, replica, seedUpdate } from './replica-harness.js';

const ok = (r) => {
	if (r && r.status !== undefined && r.status !== 'applied')
		throw new Error(`refused: ${JSON.stringify(r)}`);
};

/** The block's content as `[text, marks]` runs. */
const runs = (ed, id = 'P') =>
	ed
		.toJSON()
		.children.find((b) => b.id === id)
		.content.map((c) => [c.text, c.marks ?? {}]);

/** The single converged outcome of every assignment (fails on divergence or a problem). */
const settle = (outcomes) => {
	const seen = new Set();
	for (const o of outcomes) {
		expect(o.problems).toEqual([]);
		expect(o.results.size, [...o.results].join('\n')).toBe(1);
		seen.add(JSON.stringify(runs(o.ed)));
		for (const r of o.reps) r.destroy();
	}
	return [...seen].map((s) => JSON.parse(s));
};

const LINK = { marks: { link: { edge: 'side-dependent' } } };

describe('H5 Peritext §2.1 — overlapping marks of one value union', () => {
	it('bold "The quick" ‖ bold "quick fox" → "The quick fox" bold (exp4a)', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'The quick fox jumped' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 9, 'bold', true));
					ok(b.ed.setMark('P', 4, 9, 'bold', true));
				},
				{ assignments: clientPairs(24) }
			)
		);
		expect(out).toEqual([
			[
				['The quick fox', { bold: true }],
				[' jumped', {}]
			]
		]);
	});

	it('bold ‖ italic overlapping → both in the overlap, each alone outside it', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'The quick fox jumped' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 9, 'bold', true));
					ok(b.ed.setMark('P', 4, 9, 'italic', true));
				},
				{ assignments: clientPairs(12) }
			)
		);
		expect(out).toEqual([
			[
				['The ', { bold: true }],
				['quick', { bold: true, italic: true }],
				[' fox', { italic: true }],
				[' jumped', {}]
			]
		]);
	});

	it('three peers, three overlapping bolds → one bold run', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'abcdefghij' }],
				3,
				([a, b, c]) => {
					ok(a.ed.setMark('P', 0, 4, 'bold', true));
					ok(b.ed.setMark('P', 2, 4, 'bold', true));
					ok(c.ed.setMark('P', 5, 3, 'bold', true));
				},
				{ assignments: clientTriples(12) }
			)
		);
		expect(out).toEqual([
			[
				['abcdefgh', { bold: true }],
				['ij', {}]
			]
		]);
	});
});

describe('H5 Peritext §2.2 — conflicting values: one winner where they overlap, nothing clipped', () => {
	it('red "The quick" ‖ blue "quick fox": each keeps its own part, the overlap takes one', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'The quick fox jumped' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 9, 'color', 'red'));
					ok(b.ed.setMark('P', 4, 9, 'color', 'blue'));
				},
				{ assignments: clientPairs(24) }
			)
		);
		// One outcome per pair (by Lamport, then client id): never an unmarked tail.
		const perChar = (o) => o.flatMap(([text, marks]) => [...text].map(() => marks.color ?? '-'));
		for (const o of out) {
			const c = perChar(o);
			expect(c.slice(0, 4)).toEqual(Array(4).fill('red'));
			expect(new Set(c.slice(4, 9)).size).toBe(1);
			expect(['red', 'blue']).toContain(c[4]);
			expect(c.slice(9, 13)).toEqual(Array(4).fill('blue'));
			expect(c.slice(13)).toEqual(Array(7).fill('-'));
		}
	});

	it('a mark written after seeing another wins over it where it covers (causality)', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'Hello World' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 11, 'color', 'red'));
					b.receiveAll(a.log);
					ok(b.ed.setMark('P', 3, 5, 'color', 'blue'));
				},
				{ assignments: clientPairs(24) }
			)
		);
		expect(out).toEqual([
			[
				['Hel', { color: 'red' }],
				['lo Wo', { color: 'blue' }],
				['rld', { color: 'red' }]
			]
		]);
	});
});

describe('H5 Peritext §2.3 — removing a mark', () => {
	it('bold the whole text, then unbold a middle word: only that word is plain', () => {
		const out = settle(
			converge([{ id: 'P', text: 'The quick fox' }], 2, ([a]) => {
				ok(a.ed.setMark('P', 0, 13, 'bold', true));
				ok(a.ed.unsetMark('P', 4, 5, 'bold'));
			})
		);
		expect(out).toEqual([
			[
				['The ', { bold: true }],
				['quick', {}],
				[' fox', { bold: true }]
			]
		]);
	});

	it('bold ‖ unbold overlapping, written without seeing each other: one winner in the overlap, the rest as written', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'Hello World' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 11, 'bold', true));
					ok(a.ed.unsetMark('P', 5, 1, 'bold'));
					ok(b.ed.setMark('P', 9, 2, 'bold', true));
				},
				{ assignments: clientPairs(12) }
			)
		);
		// A's unbold is later than A's bold; B's bold covers only "ld": the space stays plain.
		expect(out).toEqual([
			[
				['Hello', { bold: true }],
				[' ', {}],
				['World', { bold: true }]
			]
		]);
	});

	it('unbold ‖ bold of the same span: the greater timestamp wins, the same on every replica', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'abc' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 3, 'bold', true));
					[a, b].forEach((r) => r !== a && r.receiveAll(a.log));
					ok(a.ed.unsetMark('P', 0, 3, 'bold'));
					ok(b.ed.setMark('P', 1, 1, 'italic', true));
				},
				{ assignments: clientPairs(12) }
			)
		);
		expect(out).toEqual([
			[
				['a', {}],
				['b', { italic: true }],
				['c', {}]
			]
		]);
	});
});

describe('H5 Peritext §2.4 — inserting at a mark’s edges: the mark record’s edge decides', () => {
	it('link set ‖ text typed at its end: the text stays out of the link on every pair (exp4b)', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'abc def' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 3, 'link', 'https://x'));
					ok(b.ed.insertText('P', 3, 'Z'));
				},
				{ semantics: LINK, assignments: clientPairs(24) }
			)
		);
		expect(out).toEqual([
			[
				['abc', { link: 'https://x' }],
				['Z def', {}]
			]
		]);
	});

	it('link set ‖ text typed at its start: the link takes it (side-dependent grows at its start)', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'x abc' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 2, 3, 'link', 'https://x'));
					ok(b.ed.insertText('P', 2, 'Z'));
				},
				{ semantics: LINK, assignments: clientPairs(24) }
			)
		);
		expect(out).toEqual([
			[
				['x ', {}],
				['Zabc', { link: 'https://x' }]
			]
		]);
	});

	it('bold set ‖ text typed at its end: bold takes it (inclusive)', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'abc def' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 3, 'bold', true));
					ok(b.ed.insertText('P', 3, 'Z'));
				},
				{ assignments: clientPairs(24) }
			)
		);
		expect(out).toEqual([
			[
				['abcZ', { bold: true }],
				[' def', {}]
			]
		]);
	});

	it('an exclusive mark takes nothing typed concurrently at either edge', () => {
		const semantics = { marks: { code: { edge: 'exclusive' } } };
		const out = settle(
			converge(
				[{ id: 'P', text: 'x abc y' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 2, 3, 'code', true));
					ok(b.ed.insertText('P', 5, 'R'));
					ok(b.ed.insertText('P', 2, 'L'));
				},
				{ semantics, assignments: clientPairs(24) }
			)
		);
		expect(out).toEqual([
			[
				['x L', {}],
				['abc', { code: true }],
				['R y', {}]
			]
		]);
	});

	it('a typed character carries exactly the marks it was given, whatever its gap shows', () => {
		const document = replica('A', seedUpdate([{ id: 'P', text: 'abc' }], LINK), 2 ** 26 + 5, {
			semantics: LINK
		});
		ok(document.ed.setMark('P', 0, 3, 'link', 'https://x'));
		// At the link's end, from inside the anchor (the view asks for the link):
		ok(document.ed.insertText('P', 3, 'd', { link: 'https://x' }));
		// At its end with no mark asked for, and in the middle with bold only:
		ok(document.ed.insertText('P', 4, 'e'));
		ok(document.ed.insertText('P', 1, 'B', { bold: true }));
		expect(runs(document.ed)).toEqual([
			['a', { link: 'https://x' }],
			['B', { bold: true }],
			['bcd', { link: 'https://x' }],
			['e', {}]
		]);
		document.destroy();
	});
});

describe('H5 Peritext §2.5 — text deleted under a mark', () => {
	it('bold "fox", its text deleted and retyped concurrently by a peer that saw the bold: the new text is plain', () => {
		const out = settle(
			converge([{ id: 'P', text: 'The fox jumped' }], 2, ([a, b]) => {
				ok(a.ed.setMark('P', 4, 3, 'bold', true));
				b.receiveAll(a.log);
				ok(b.ed.deleteText('P', 4, 3));
				ok(b.ed.insertText('P', 4, 'cat'));
			})
		);
		expect(out).toEqual([[['The cat jumped', {}]]]);
	});

	it('a bold range’s first and last characters deleted concurrently with the bold: the rest stays bold', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'abcdef' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 1, 4, 'bold', true));
					ok(b.ed.deleteText('P', 4, 1));
					ok(b.ed.deleteText('P', 1, 1));
				},
				{ assignments: clientPairs(12) }
			)
		);
		expect(out).toEqual([
			[
				['a', {}],
				['cd', { bold: true }],
				['f', {}]
			]
		]);
	});
});

describe('H5 comments keyed `comment:<id>` never clip each other', () => {
	it('two overlapping comments by two peers both survive whole', () => {
		const out = settle(
			converge(
				[{ id: 'P', text: 'The quick fox jumped' }],
				2,
				([a, b]) => {
					ok(a.ed.setMark('P', 0, 9, 'comment:c1', { id: 'c1' }));
					ok(b.ed.setMark('P', 4, 9, 'comment:c2', { id: 'c2' }));
				},
				{ assignments: clientPairs(12) }
			)
		);
		expect(out).toEqual([
			[
				['The ', { 'comment:c1': { id: 'c1' } }],
				['quick', { 'comment:c1': { id: 'c1' }, 'comment:c2': { id: 'c2' } }],
				[' fox', { 'comment:c2': { id: 'c2' } }],
				[' jumped', {}]
			]
		]);
	});
});

describe('H5 marks under undo and redo', () => {
	it('undo of a bold removes exactly it; redo puts it back, paired as before', () => {
		const r = replica('A', seedUpdate([{ id: 'P', text: 'abcdef' }]), 2 ** 26 + 7);
		ok(r.ed.setMark('P', 0, 4, 'bold', true));
		ok(r.ed.setMark('P', 2, 4, 'bold', true));
		expect(runs(r.ed)).toEqual([['abcdef', { bold: true }]]);
		r.undo();
		expect(runs(r.ed)).toEqual([
			['abcd', { bold: true }],
			['ef', {}]
		]);
		r.redo();
		expect(runs(r.ed)).toEqual([['abcdef', { bold: true }]]);
		r.undo();
		r.undo();
		expect(runs(r.ed)).toEqual([['abcdef', {}]]);
		expect(r.problems).toEqual([]);
		r.destroy();
	});
});
