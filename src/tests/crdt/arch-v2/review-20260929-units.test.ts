/**
 * Adversarial review 2026-09-29 (`docs/reviews/2026-09-29-adversarial-review.md`),
 * CRDT-core units. Every row runs under the plan §8 multi-replica rule
 * (`converge`: three client-id assignments, both delivery orders, duplicate
 * delivery, binary reload) and every replica is held to `wellFormed` after
 * every write and delivery. Expected trees are hand-authored from the
 * report's "Done when" lines.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';
import { converge, replica, seedUpdate, tree } from './p1-harness.js';

/** Every outcome converged, well-formed, and shows `expected`. */
const expectTree = (outcomes, expected: string) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
		expect(tree(o.ed)).toBe(expected);
	}
};

describe('UW-20: a merge unnests the source’s children after the vacated slot', () => {
	const seed = (tail: boolean) => [
		{ id: 'P', text: 'p' },
		{
			id: 'X',
			text: 'x',
			children: [
				{ id: 'K', text: 'k' },
				{ id: 'K2', text: 'k2' }
			]
		},
		...(tail ? [{ id: 'Z', text: 'z' }] : [])
	];

	for (const tail of [true, false]) {
		const expected = `X:"x" K:"k" K2:"k2"${tail ? ' Z:"z"' : ''}`;
		const label = tail ? '' : ' (last-sibling source)';

		it(`mergeBackward X into P ‖ delete P → ${expected}${label}`, () => {
			expectTree(
				converge(seed(tail), 2, ([a, b]) => {
					a.ed.mergeBackward('X');
					b.ed.deleteBlock('P');
				}),
				expected
			);
		});

		it(`mergeForward P pulls X ‖ delete P → ${expected}${label}`, () => {
			expectTree(
				converge(seed(tail), 2, ([a, b]) => {
					a.ed.mergeForward('P');
					b.ed.deleteBlock('P');
				}),
				expected
			);
		});

		it(`range delete P@1..X@0 (merge + rescue) ‖ delete P → ${expected}${label}`, () => {
			expectTree(
				converge(seed(tail), 2, ([a, b]) => {
					a.ed.deleteRange({ block: 'P', offset: 1 }, { block: 'X', offset: 0 });
					b.ed.deleteBlock('P');
				}),
				expected
			);
		});
	}
});

describe('wellFormed oracle finding: toJSON never depends on read history', () => {
	it('the interner keeps one canonical key order, whichever order it saw first', () => {
		const r = replica('A', seedUpdate([{ id: 'P', text: 'p' }]), 20);
		const intern = r.ed.runsView.view().intern;
		const first = intern({ color: 'red', bold: 'blue' });
		expect(Object.keys(first)).toEqual(['bold', 'color']);
		expect(intern({ bold: 'blue', color: 'red' })).toBe(first);
		r.destroy();
	});
});

describe('UW-01: undo/redo of a raced type/data write keeps a defined value', () => {
	// CLIENT_IDS[2] = [[20,30],[30,20],[7,100]]: the larger client id wins a
	// concurrent attr write, so A (the undoer) wins only in the second order.
	const AWINS = [false, true, false];
	/** Both replicas race `write`, sync, then A runs `history` (undo, or undo+redo). */
	const race = (seeds, write, history) =>
		converge(seeds, 2, ([a, b]) => {
			write(a, 'mine');
			write(b, 'theirs');
			a.receiveAll(b.log);
			b.receiveAll(a.log);
			history(a);
		});
	const undo = (a) => expect(a.undo()).not.toBe(undefined);
	const undoRedo = (a) => {
		a.undo();
		a.redo();
	};
	/** A's undo restores what A overwrote when A won; B's surviving write stays otherwise. */
	const expectEach = (outcomes, read, won: unknown, lost: unknown) =>
		outcomes.forEach((o, i) => {
			expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
			expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
			for (const r of o.reps) expect(read(r.ed), `${i} ${r.name}`).toEqual(AWINS[i] ? won : lost);
		});

	const P = [{ id: 'P', text: 'p', data: { v: 0 } }];
	const types = { mine: 'heading', theirs: 'quote' };
	const retype = (r, who) => r.ed.setBlockType('P', types[who]);
	const redata = (r, who) => r.ed.setBlockData('P', { v: who });
	const M = [
		{
			id: 'P',
			content: [{ text: 'a' }, { type: 'mention', id: 'M', data: { v: 0 } }, { text: 'b' }]
		}
	];
	const inlineData = (ed) => ed.contentItems('P').find((c) => c.kind === 'inline')?.data;
	const reinline = (r, who) => r.ed.setInlineData('P', 'M', { v: who });

	it('setBlockType × undo', () => {
		expectEach(race(P, retype, undo), (ed) => ed.blockTypeOf('P'), 'paragraph', 'quote');
	});
	it('setBlockType × undo + redo', () => {
		expectEach(race(P, retype, undoRedo), (ed) => ed.blockTypeOf('P'), 'heading', 'quote');
	});
	it('setBlockData × undo', () => {
		expectEach(race(P, redata, undo), (ed) => ed.blockDataOf('P'), { v: 0 }, { v: 'theirs' });
	});
	it('setBlockData × undo + redo', () => {
		expectEach(
			race(P, redata, undoRedo),
			(ed) => ed.blockDataOf('P'),
			{ v: 'mine' },
			{
				v: 'theirs'
			}
		);
	});
	it('setInlineData × undo', () => {
		expectEach(race(M, reinline, undo), inlineData, { v: 0 }, { v: 'theirs' });
	});
	it('setInlineData × undo + redo', () => {
		expectEach(race(M, reinline, undoRedo), inlineData, { v: 'mine' }, { v: 'theirs' });
	});

	it('lastChangedBy reverts to the previous author when the undoer won LWW', () => {
		// CLIENT_IDS[3] = [[20,30,40],[40,30,20],[30,40,20]]: A beats B only in the second.
		const outcomes = converge(P, 3, ([a, b, c]) => {
			c.ed.insertText('P', 1, 'c');
			a.receiveAll(c.log);
			b.receiveAll(c.log);
			a.ed.setBlockType('P', 'heading');
			b.ed.setBlockType('P', 'quote');
			a.receiveAll(b.log);
			b.receiveAll(a.log);
			a.undo();
		});
		outcomes.forEach((o, i) => {
			expect(o.problems).toEqual([]);
			expect(o.results.size).toBe(1);
			for (const r of o.reps) {
				expect(r.ed.blockTypeOf('P')).toBe(i === 1 ? 'paragraph' : 'quote');
				expect(r.ed.blockAttribution('P')?.lastChangedBy).toBe(i === 1 ? 'C' : 'B');
			}
		});
	});
});

describe('UW-01: the serializer never emits a typeless registered block', () => {
	it('blockJSON asserts in DEV instead of emitting type ""', () => {
		const r = replica('A', seedUpdate([{ id: 'P', text: 'p' }]), 20);
		r.doc.transact(() => r.ed.model.blockNodeOf(r.doc, 'P').deleteAttr('type'));
		expect(() => r.ed.toJSON()).toThrow(/block P has no type/);
		expect(r.ed.blockJSON('ghost').type).toBe('');
		r.destroy();
	});
});

describe('UW-21: a void kind never holds children (the target role decides)', () => {
	const semantics = { roles: { divider: { void: true }, callout: { island: true } } };
	const seed = (type = 'paragraph', kid = 'paragraph') => [
		{ id: 'P', text: 'p', type, children: [{ id: 'K', text: 'k', type: kid }] },
		{ id: 'Z', text: 'z' }
	];
	/** One replica; `op` runs on its facade; returns the facade after the checks. */
	const run = (seeds, op) => {
		const [o] = converge(seeds, 1, ([a]) => op(a.ed), { semantics, assignments: [[20]] });
		expect(o.problems, 'well-formed after every write').toEqual([]);
		return o.ed;
	};
	const noVoidParent = (ed) =>
		expect(ed.listBlockIds().filter((id) => ed.isVoid(id) && ed.childrenIds(id).length)).toEqual(
			[]
		);

	it('setBlockType to a void kind unnests the children right after the block', () => {
		const ed = run(seed(), (ed) => expect(ed.setBlockType('P', 'divider').status).toBe('applied'));
		expect(tree(ed)).toBe('P:"p" K:"k" Z:"z"');
		expect(ed.blockTypeOf('K')).toBe('paragraph');
		noVoidParent(ed);
	});

	it('an island retyped to a void kind resets its children to the slot’s default type', () => {
		const ed = run(seed('callout', 'line'), (ed) => ed.setBlockType('P', 'divider'));
		expect(tree(ed)).toBe('P:"p" K:"k" Z:"z"');
		expect(ed.blockTypeOf('K')).toBe('paragraph');
		noVoidParent(ed);
	});

	it('setBlock({type: void}) unnests too; with children it refuses; `children: []` replaces', () => {
		let ed = run(seed(), (ed) => ed.setBlock('P', { type: 'divider', data: {} }));
		expect(tree(ed)).toBe('P:"p" K:"k" Z:"z"');
		noVoidParent(ed);
		ed = run(seed(), (ed) =>
			expect(
				ed.setBlock('P', { type: 'divider', children: [{ id: 'N', type: 'paragraph' }] }).status
			).toBe('refused')
		);
		expect(tree(ed)).toBe('P:"p"[K:"k"] Z:"z"');
		ed = run(seed(), (ed) => ed.setBlock('P', { type: 'divider', children: [] }));
		expect(tree(ed)).toBe('P:"p" Z:"z"');
	});

	it('undo restores the children under the retyped block, redo unnests them again', () => {
		const [o] = converge(
			seed(),
			1,
			([a]) => {
				a.ed.setBlockType('P', 'divider');
				a.undo();
				expect(a.tree()).toBe('P:"p"[K:"k"] Z:"z"');
				a.redo();
			},
			{ semantics, assignments: [[20]] }
		);
		expect(o.problems).toEqual([]);
		expect(tree(o.ed)).toBe('P:"p" K:"k" Z:"z"');
	});

	it('UW-21b: a void shows no children by the roles the document holds — adopted late too', () => {
		const document = createDocument({
			value: {
				children: [
					{
						id: 'P',
						type: 'divider',
						content: [{ text: 'p' }],
						children: [{ id: 'K', type: 'paragraph', content: [{ text: 'k' }] }]
					},
					{ id: 'Z', type: 'paragraph', content: [{ text: 'z' }] }
				]
			}
		});
		const ed = document.facade;
		const changes: unknown[] = [];
		ed.onChange((c) => changes.push(c));
		// No roles yet: a divider is any kind, its child shows under it.
		expect(tree(ed)).toBe('P:"p"[K:"k"] Z:"z"');
		document.adoptSemantics(semantics);
		expect(tree(ed)).toBe('P:"p" K:"k" Z:"z"');
		expect([ed.parentOf('K'), ed.childrenIds('P'), ed.order()]).toEqual([
			null,
			[],
			['P', 'K', 'Z']
		]);
		// Retyping it back to a kind that holds children shows the child under it again.
		ed.setBlockType('P', 'paragraph');
		expect(tree(ed)).toBe('P:"p"[K:"k"] Z:"z"');
		expect(changes.length).toBeGreaterThan(0);
		document.destroy();
	});
});
