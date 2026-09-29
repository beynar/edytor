/**
 * Re-score 3 (`docs/reviews/2026-09-30-rescore-3.md`), CRDT units. Every row
 * runs under the plan §8 multi-replica rule (`converge`: three client-id
 * assignments, both delivery orders, duplicate delivery, binary reload) and
 * every replica is held to `wellFormed` after every write and delivery.
 * Expected trees are hand-authored from the units' "Done when" lines.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { converge, tree } from './p1-harness.js';

const semantics = {
	roles: { code: { island: true }, divider: { void: true } },
	rendersContent: { code: false },
	defaultChild: { code: 'codeLine' }
};

/** `id:type[children]` of the visible tree. */
const typed = (ed) => {
	const show = (b) =>
		`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
	return ed.toJSON().children.map(show).join(' ');
};

/** Every outcome converged and well-formed. */
const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

/**
 * FW-01: Ada deletes or merges away a code block, Bob nests the paragraph
 * after it under the former line (it is a plain paragraph by then), and Ada
 * undoes. The line is a code line in its code block again, and a code line
 * holds no children: Bob's paragraph displays right after the code block,
 * visible and movable, on every replica.
 */
describe('FW-01: undo of an island delete or merge never seals a peer’s block inside it', () => {
	const code = [
		{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'a' }] },
		{ id: 'N', text: 'n' }
	];
	const withP = [{ id: 'P', text: 'p' }, ...code];
	const cases = {
		delete: { seed: code, run: (ed) => ed.deleteBlocks(['C']), before: '' },
		'merge (Backspace)': { seed: withP, run: (ed) => ed.mergeBackward('C'), before: 'P:"p" ' },
		'merge (Delete)': { seed: withP, run: (ed) => ed.mergeForward('P'), before: 'P:"p" ' },
		'engine merge': { seed: withP, run: (ed) => ed.mergeBlocks('C', 'P'), before: 'P:"p" ' }
	};

	/** Ada's island edit, Bob's nest of N under the line, Ada's undo — then `after`. */
	const race = (seed, run, after = () => {}) =>
		converge(
			seed,
			2,
			([a, b]) => {
				const edit = a.capture(() => expect(run(a.ed).status).toBe('applied'));
				b.receiveAll(edit);
				const nest = b.capture(() => expect(b.ed.nestBlock('N', 'L1').status).toBe('applied'));
				a.receiveAll(nest);
				expect(a.undo()).not.toBe(undefined);
				after(a, b);
			},
			{ semantics }
		);

	for (const [name, { seed, run, before }] of Object.entries(cases)) {
		it(`${name} the code block ‖ nest N under its line, then undo → N shows after the code block`, () => {
			for (const o of one(race(seed, run))) {
				expect(tree(o.ed)).toBe(`${before}C:""[L1:"a"] N:"n"`);
				expect(typed(o.ed)).toContain('C:code[L1:codeLine] N:paragraph');
				for (const r of o.reps) {
					expect(r.ed.canPlace(['N']), `${r.name}: N is movable`).toBe(true);
					expect(r.ed.islandOf('N'), `${r.name}: N is outside the island`).toBe(null);
				}
			}
		});
	}

	it('…then Bob moves N to the top → it moves like any block', () => {
		for (const o of one(
			race(code, cases.delete.run, (a, b) => {
				b.receiveAll(a.log);
				expect(b.ed.moveBlock('N', { parent: null, index: 0 }).status).toBe('applied');
			})
		)) {
			expect(typed(o.ed)).toBe('N:paragraph C:code[L1:codeLine]');
		}
	});

	it('…then Ada redoes → the line is a paragraph again and N nests under it', () => {
		for (const o of one(race(code, cases.delete.run, (a) => a.redo()))) {
			expect(tree(o.ed)).toBe('L1:"a"[N:"n"]');
			expect(typed(o.ed)).toBe('L1:paragraph[N:paragraph]');
		}
	});
});

/**
 * SW-crdt-1 (sweep): Ada deletes a code block, Bob turns its former line —
 * a plain paragraph by then — into a heading, and Ada undoes. The undo puts
 * the line back in its code block; an island shows only its line kind, so
 * the line displays as a code line (the stored heading shows again once the
 * line leaves the island, e.g. when Ada redoes).
 */
describe('SW-crdt-1: a line a peer retyped outside its island shows as a line when an undo puts it back', () => {
	const code = [
		{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'a' }] },
		{ id: 'N', text: 'n' }
	];
	const race = (after = (a) => {}) =>
		converge(
			code,
			2,
			([a, b]) => {
				b.receiveAll(a.capture(() => a.ed.deleteBlocks(['C'])));
				a.receiveAll(b.capture(() => b.ed.setBlockType('L1', 'heading')));
				expect(a.undo()).not.toBe(undefined);
				after(a);
			},
			{ semantics }
		);

	it('delete the code block ‖ retype its line to a heading, then undo → a code line in the code block', () => {
		for (const o of one(race())) {
			expect(typed(o.ed)).toBe('C:code[L1:codeLine] N:paragraph');
			for (const r of o.reps) expect(r.ed.blockTypeOf('L1')).toBe('codeLine');
		}
	});

	it('…then redo → the line leaves the island and shows the heading again', () => {
		for (const o of one(race((a) => a.redo()))) {
			expect(typed(o.ed)).toBe('L1:heading N:paragraph');
		}
	});
});

/**
 * SW-crdt-2 (sweep): the engine merge (`mergeFrom`) of a block outside a code
 * block into the code block itself crossed the island's edge: the text went
 * into the code block's own content, which a code block never renders, and
 * the children became lines. A merge never crosses an island's edge, so it
 * is refused, as the edge rule says.
 */
describe('SW-crdt-2: a merge into an island from outside it is refused', () => {
	const seed = [
		{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'a' }] },
		{ id: 'N', text: 'n', children: [{ id: 'K', text: 'k' }] }
	];

	it('mergeBlocks N into C → refused, nothing written', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.canMerge('N', 'C')).toBe(false);
					expect(a.ed.mergeBlocks('N', 'C').status).toBe('refused');
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('C:""[L1:"a"] N:"n"[K:"k"]');
		}
	});

	it('a line still merges into its own code block, and the code block into a paragraph', () => {
		const ed = converge(seed, 1, () => {}, { semantics })[0].ed;
		expect(ed.canMerge('L1', 'C')).toBe(true);
		expect(ed.canMerge('C', 'N')).toBe(true);
	});
});

/**
 * SW-crdt-3 (sweep, low): a code line holds no children (FW-01), so
 * inserting under one is refused like inserting under a void — it used to
 * report `applied` for a block that then showed after the code block.
 */
describe('SW-crdt-3: inserting under a code line is refused', () => {
	it('insertBlock under L1 → refused; into the code block → applied', () => {
		const ed = converge(
			[{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'a' }] }],
			1,
			() => {},
			{ semantics }
		)[0].ed;
		const line = (id: string) => ({ id, type: 'codeLine', content: [{ kind: 'text', text: id }] });
		expect(ed.insertBlock({ parent: 'L1', index: 0 }, line('X')).status).toBe('refused');
		expect(ed.insertBlock({ parent: 'C', index: 1 }, line('L2')).status).toBe('applied');
		expect(typed(ed)).toBe('C:code[L1:codeLine,L2:codeLine]');
	});
});

/**
 * SW-crdt-4 (sweep): Ada deletes a code block, Bob moves one of its former
 * lines (a paragraph by then) elsewhere, and Ada undoes. Bob's move holds, so
 * the line stays where he put it, and Ada's undo restores its stored kind: it
 * showed as a code line outside any code block. A line kind outside its
 * island shows as its parent's default child, like a promoted line (RW-01).
 */
describe('SW-crdt-4: a line a peer moved away shows no code line kind when an undo restores it', () => {
	const code = [
		{ id: 'P', text: 'p' },
		{
			id: 'C',
			type: 'code',
			text: '',
			children: [
				{ id: 'L1', type: 'codeLine', text: 'a' },
				{ id: 'L2', type: 'codeLine', text: 'b' }
			]
		},
		{ id: 'N', text: 'n' }
	];
	const moves = {
		'moves it to the top': (ed) => ed.moveBlock('L1', { parent: null, index: 0 }),
		'nests it under N': (ed) => ed.nestBlock('L1', 'N')
	};
	const expected = {
		'moves it to the top': 'L1:paragraph P:paragraph C:code[L2:codeLine] N:paragraph',
		'nests it under N': 'P:paragraph C:code[L2:codeLine] N:paragraph[L1:paragraph]'
	};
	for (const [name, move] of Object.entries(moves)) {
		it(`delete the code block ‖ Bob ${name}, then undo → a paragraph where Bob put it`, () => {
			for (const o of one(
				converge(
					code,
					2,
					([a, b]) => {
						b.receiveAll(a.capture(() => a.ed.deleteBlocks(['C'])));
						a.receiveAll(b.capture(() => expect(move(b.ed).status).toBe('applied')));
						expect(a.undo()).not.toBe(undefined);
					},
					{ semantics }
				)
			)) {
				expect(typed(o.ed)).toBe(expected[name]);
				for (const r of o.reps) expect(r.ed.blockTypeOf('L1')).toBe('paragraph');
			}
		});
	}
});

/**
 * SW-crdt-5 (sweep, low): `setBlockType` of a code block to a paragraph left
 * its code lines as code lines under a paragraph. Its children now take the
 * new kind's default child, as a delete or merge of the island does.
 */
describe('SW-crdt-5: retyping an island to an ordinary kind retypes its lines', () => {
	it('setBlockType C → paragraph → its lines are paragraphs; undo → code lines again', () => {
		for (const o of one(
			converge(
				[
					{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'a' }] }
				],
				1,
				([a]) => {
					expect(a.ed.setBlockType('C', 'paragraph').status).toBe('applied');
					expect(typed(a.ed)).toBe('C:paragraph[L1:paragraph]');
					a.undo();
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('C:code[L1:codeLine]');
		}
	});
});

describe('SW-crdt-4: the line rules read stored kinds when asked (no stale kind after a retype)', () => {
	it('a paragraph retyped to codeLine outside the code block shows, and reports, as a paragraph', () => {
		for (const o of one(
			converge(
				[
					{
						id: 'C',
						type: 'code',
						text: '',
						children: [{ id: 'L1', type: 'codeLine', text: 'a' }]
					},
					{ id: 'N', text: 'n' }
				],
				2,
				([a]) => {
					expect(a.ed.setBlockType('N', 'codeLine').status).toBe('applied');
					expect(a.ed.blockTypeOf('N')).toBe('paragraph');
					expect(a.ed.setBlockType('N', 'heading').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('C:code[L1:codeLine] N:heading');
		}
	});
});
