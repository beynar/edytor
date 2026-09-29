/**
 * arch-v2 phase 2 P1.1 — the native review's scenario probes
 * (`review-probes/scenarios.test.ts`, `split-moved.test.ts`,
 * `cycle-min.test.ts`, `capabilities.test.ts`) re-targeted at arch-v2.
 *
 * The probes were written against a different engine (`BoundaryDocument`);
 * the SCENARIOS and their EXPECTATIONS are ported, the code is not. Each row
 * runs through the facade on real documents (`p1-harness.ts`) under the plan
 * §8 multi-replica rule: three client-id assignments, both delivery orders
 * to an observer, duplicate delivery, and a binary reload of every replica.
 *
 * Expected values come from `docs/editor-delete-contract.md` and plan §8
 * (the rows cited per test), never from running arch-v2. Where arch-v2's
 * contract differs from the native probe's expectation, the row pins
 * arch-v2's contract and says so (`DIVERGENCE:` — also recorded in the
 * Phase 2 table of `docs/architecture-v2/execution-ledger.md`):
 *
 * - promote-children (native §9) and move under a concurrently deleted
 *   block (native 6b) agree with native since UW-08: promotion is derived
 *   when the document is read, so an unmarked block under a deleted one —
 *   a child the deleter saw, one a peer created, split off or moved there
 *   concurrently — takes the deleted block's slot (MV06b).
 * - undo of a create / a multi-line paste after a peer typed inside the
 *   created block (native 5d, 5f): the undo deletes the block and the peer's
 *   text dies with it (`conc.delete-wins-block`, F-D19), native keeps it.
 * - selective undo (native `undo(opId)`): arch-v2 history is a per-actor
 *   stack (`document.history`), so "undo op X" is ported as the stack pops
 *   that reach X.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { allText, converge, replica, seedUpdate, tree } from './p1-harness.js';

const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};
/** Visible block texts in document order (replica 0). */
const texts = (o) => o.ed.order().map((id) => o.ed.blockText(id));
const sorted = (s: string) => [...s].sort().join('');

describe('2. intent at a shared gap', () => {
	it('2a split `hello world` at 6 ‖ type X at 6 — converges, nothing lost or duplicated (F-D14: side is YATA order)', () => {
		for (const o of one(
			converge([{ id: 'P', text: 'hello world' }], 2, ([a, b]) => {
				a.ed.splitBlock('P', 6, 'S');
				b.ed.insertText('P', 6, 'X');
			})
		)) {
			expect(sorted(allText(o.ed))).toBe(sorted('hello worldX'));
			expect(o.ed.order()).toEqual(['P', 'S']);
		}
	});

	it('2b concurrent splits at 3 and 8 → `hel` | `lo wo` | `rld` (F-D11)', () => {
		for (const o of one(
			converge([{ id: 'P', text: 'hello world' }], 2, ([a, b]) => {
				a.ed.splitBlock('P', 3, 'S1');
				b.ed.splitBlock('P', 8, 'S2');
			})
		)) {
			// F-D11: the partition; reading order of concurrently split siblings is tracked only (D-18).
			expect([...texts(o)].sort()).toEqual(['hel', 'lo wo', 'rld'].sort());
			expect(texts(o)[0]).toBe('hel');
		}
	});

	it('2b3 three replicas split at 3, 8 and 6 → `hel` | `lo ` | `wo` | `rld` (F-D11, D-18)', () => {
		for (const o of one(
			converge([{ id: 'P', text: 'hello world' }], 3, ([a, b, c]) => {
				a.ed.splitBlock('P', 3, 'S1');
				b.ed.splitBlock('P', 8, 'S2');
				c.ed.splitBlock('P', 6, 'S3');
			})
		)) {
			expect([...texts(o)].sort()).toEqual(['hel', 'lo ', 'wo', 'rld'].sort());
			// The head keeps its place; the order of the three concurrently
			// split-born siblings is D-18 (tracked, not decided): observed
			// `hel|rld|wo|lo ` and `hel|rld|lo |wo` on two of the three
			// assignments — the native probe's `hel|lo |wo|rld` is not an
			// arch-v2 contract (DIVERGENCE, recorded).
			expect(texts(o)[0]).toBe('hel');
		}
	});

	it('2c same-gap concurrent typing mid-text never interleaves (char by char)', () => {
		for (const o of one(
			converge([{ id: 'P', text: 'hello world' }], 2, ([a, b]) => {
				for (const [i, ch] of [...'abc'].entries()) a.ed.insertText('P', 5 + i, ch);
				for (const [i, ch] of [...'xyz'].entries()) b.ed.insertText('P', 5 + i, ch);
			})
		)) {
			expect(['helloabcxyz world', 'helloxyzabc world']).toContain(o.ed.blockText('P'));
		}
	});

	it('2d same-gap concurrent typing at block end never interleaves', () => {
		for (const o of one(
			converge([{ id: 'P', text: 'hello' }], 2, ([a, b]) => {
				for (const [i, ch] of [...'abc'].entries()) a.ed.insertText('P', 5 + i, ch);
				for (const [i, ch] of [...'xyz'].entries()) b.ed.insertText('P', 5 + i, ch);
			})
		)) {
			expect(['helloabcxyz', 'helloxyzabc']).toContain(o.ed.blockText('P'));
		}
	});
});

describe('3. delete wins the block (conc.delete-wins-block)', () => {
	const seeds = [
		{ id: 'b0', text: 'zero' },
		{ id: 'b1', text: 'one' },
		{ id: 'b2', text: 'two' }
	];

	it('3a delete b1 ‖ type inside b1 → the insert dies with the block', () => {
		for (const o of one(
			converge(seeds, 2, ([a, b]) => {
				a.ed.deleteBlocks(['b1']);
				b.ed.insertText('b1', 1, 'XX');
			})
		)) {
			expect(tree(o.ed)).toBe('b0:"zero" b2:"two"');
		}
	});

	it('3b delete b1 ‖ split b1 and type in the tail → the split-born tail survives (F-D20, ST02a)', () => {
		const s = [
			{ id: 'b0', text: 'zero' },
			{ id: 'b1', text: 'onetail' },
			{ id: 'b2', text: 'two' }
		];
		for (const o of one(
			converge(s, 2, ([a, b]) => {
				a.ed.deleteBlocks(['b1']);
				b.ed.splitBlock('b1', 3, 'T');
				b.ed.insertText('T', 4, '!');
			})
		)) {
			expect(tree(o.ed)).toBe('b0:"zero" T:"tail!" b2:"two"');
		}
	});

	it('3c range delete b0@2 → b2@1 ‖ type inside b1 → `zewo`; the insert dies with b1 (del.range.flat)', () => {
		for (const o of one(
			converge(seeds, 2, ([a, b]) => {
				a.ed.deleteRange({ block: 'b0', offset: 2 }, { block: 'b2', offset: 1 });
				b.ed.insertText('b1', 1, 'XX');
			})
		)) {
			expect(tree(o.ed)).toBe('b0:"zewo"');
		}
	});
});

describe('4. merge then delete', () => {
	const seeds = [
		{ id: 'a', text: 'AAA' },
		{ id: 'b', text: 'BBB' },
		{ id: 'c', text: 'CCC' }
	];

	it('4a sequential: merge b into a, delete a → `[c]` everywhere; undo → `[a "AAABBB", c]` (F-D8)', () => {
		for (const o of one(
			converge(seeds, 1, ([x]) => {
				expect(x.ed.mergeBackward('b').status).toBe('applied');
				expect(x.tree()).toBe('a:"AAABBB" c:"CCC"');
				expect(x.ed.deleteBlocks(['a']).status).toBe('applied');
				expect(x.tree()).toBe('c:"CCC"');
			})
		)) {
			expect(tree(o.ed)).toBe('c:"CCC"');
			// F-D8: undo of the delete returns the merged block.
			o.reps[0].undo();
			expect(o.reps[0].tree()).toBe('a:"AAABBB" c:"CCC"');
		}
	});

	it('4b concurrent: X merges b into a ‖ Y deletes a → a gone, b visible (F-D9, ST02b)', () => {
		for (const o of one(
			converge(seeds, 2, ([x, y]) => {
				x.ed.mergeBackward('b');
				y.ed.deleteBlocks(['a']);
			})
		)) {
			expect(tree(o.ed)).toBe('b:"BBB" c:"CCC"');
		}
	});

	it('4c merge, delete, then a peer that saw only the merge types into b’s facet → nothing of b resurrects', () => {
		for (const o of one(
			converge(
				[
					{ id: 'a', text: 'AAA' },
					{ id: 'b', text: 'BBB' }
				],
				2,
				([x, y]) => {
					const merge = x.capture(() => x.ed.mergeBackward('b'));
					y.receiveAll(merge);
					x.ed.deleteBlocks(['a']);
					y.ed.insertText('a', 5, 'Q'); // inside b's text, displayed in a
				}
			)
		)) {
			expect(allText(o.ed)).not.toContain('B');
			expect(allText(o.ed)).not.toContain('Q');
		}
	});
});

describe('5. undo with collaboration (conc.undo.actor-local)', () => {
	/** Two replicas A, B on `seeds`; `program` runs with explicit deliveries. */
	const pair = (seeds, program) => converge(seeds, 2, ([a, b]) => program(a, b));

	it('5a A types, the peer inserts before it, A undoes → only A’s text goes', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abc' }], (a, b) => {
				b.receiveAll(a.capture(() => a.ed.insertText('p', 3, 'XYZ')));
				a.receiveAll(b.capture(() => b.ed.insertText('p', 3, 'Q')));
				b.receiveAll(a.capture(() => a.undo()));
				expect(a.ed.blockText('p')).toBe('abcQ');
			})
		)) {
			expect(o.ed.blockText('p')).toBe('abcQ');
		}
	});

	it('5a2 the peer inserts INSIDE A’s typed run, A undoes → `abcQ`', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abc' }], (a, b) => {
				b.receiveAll(a.capture(() => a.ed.insertText('p', 3, 'XYZ')));
				a.receiveAll(b.capture(() => b.ed.insertText('p', 5, 'Q')));
				b.receiveAll(a.capture(() => a.undo()));
			})
		)) {
			expect(o.ed.blockText('p')).toBe('abcQ');
		}
	});

	it('5b undo of a delete after the peer edited inside the deleted range offline → `abQcde`', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abcde' }], (a, b) => {
				const d = a.capture(() => a.ed.deleteText('p', 1, 3));
				const q = b.capture(() => b.ed.insertText('p', 2, 'Q'));
				a.receiveAll(q);
				b.receiveAll(d);
				expect(a.ed.blockText('p')).toBe('aQe');
				b.receiveAll(a.capture(() => a.undo()));
				expect(a.ed.blockText('p')).toBe('abQcde');
			})
		)) {
			expect(o.ed.blockText('p')).toBe('abQcde');
		}
	});

	it('5c redo after a remote edit → `abcXY` or `abcYX`', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abc' }], (a, b) => {
				b.receiveAll(a.capture(() => a.ed.insertText('p', 3, 'X')));
				b.receiveAll(a.capture(() => a.undo()));
				a.receiveAll(b.capture(() => b.ed.insertText('p', 3, 'Y')));
				b.receiveAll(a.capture(() => a.redo()));
			})
		)) {
			expect(['abcXY', 'abcYX']).toContain(o.ed.blockText('p'));
		}
	});

	it('5d undo of a block create after the peer typed in it → the block stays with the peer text (hist.undo.withdraw)', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abc' }], (a, b) => {
				b.receiveAll(
					a.capture(() =>
						a.ed.insertBlock({ parent: null, index: 1 }, { id: 'n', type: 'paragraph' })
					)
				);
				a.receiveAll(b.capture(() => b.ed.insertText('n', 0, 'peer text')));
				b.receiveAll(a.capture(() => a.undo()));
			})
		)) {
			// native: `peer text` survives — and since the 2026-09-28 contract,
			// arch-v2 too: the undo removes only the undoer's contributions.
			expect(tree(o.ed)).toBe('p:"abc" n:"peer text"');
		}
	});

	it('5e undo of a split keeps the peer text typed in the tail (HI01a)', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abcd' }], (a, b) => {
				b.receiveAll(a.capture(() => a.ed.splitBlock('p', 2, 's')));
				a.receiveAll(b.capture(() => b.ed.insertText('s', 2, 'X')));
				b.receiveAll(a.capture(() => a.undo()));
			})
		)) {
			expect(tree(o.ed)).toBe('p:"abcdX"');
		}
	});

	it('5f undo of a multi-line paste after the peer typed in a pasted line → the line stays with the peer text (hist.undo.withdraw)', () => {
		for (const o of one(
			pair([{ id: 'p', text: 'abcd' }], (a, b) => {
				const paste = a.capture(() =>
					expect(
						a.ed.insertFlow(
							{ block: 'p', offset: 2 },
							{
								lines: [
									{ id: 'l1', content: [{ kind: 'text', text: 'L1' }] },
									{ id: 'l2', content: [{ kind: 'text', text: 'L2' }] },
									{ id: 'l3', content: [{ kind: 'text', text: 'L3' }] }
								]
							}
						).status
					).toBe('applied')
				);
				b.receiveAll(paste);
				// flow.split: `abL1` | `L2` | `L3cd`
				expect(b.texts()).toEqual(['abL1', 'L2', 'L3cd']);
				const second = b.ed.order()[1];
				a.receiveAll(b.capture(() => b.ed.insertText(second, 1, 'PEER')));
				b.receiveAll(a.capture(() => a.undo()));
			})
		)) {
			// native keeps `PEER`; so does arch-v2 since the 2026-09-28 contract:
			// the pasted text goes, the line the peer typed in stays with `PEER`,
			// and the split tail's text rides back into `p`.
			expect(texts(o)).toEqual(['abcd', 'PEER']);
		}
	});

	it('5g undo of a merge after the peer typed in the merged source part → `ab` | `cXd` (HI01b)', () => {
		for (const o of one(
			pair(
				[
					{ id: 'p', text: 'ab' },
					{ id: 'q', text: 'cd' }
				],
				(a, b) => {
					b.receiveAll(a.capture(() => a.ed.mergeBackward('q')));
					a.receiveAll(b.capture(() => b.ed.insertText('p', 3, 'X'))); // c|X|d
					b.receiveAll(a.capture(() => a.undo()));
				}
			)
		)) {
			expect(tree(o.ed)).toBe('p:"ab" q:"cXd"');
		}
	});

	it('5h undo of a block delete after the peer edited inside it offline → `cXd` (F-D17)', () => {
		for (const o of one(
			pair(
				[
					{ id: 'p', text: 'ab' },
					{ id: 'q', text: 'cd' }
				],
				(a, b) => {
					const d = a.capture(() => a.ed.deleteBlocks(['q']));
					const t = b.capture(() => b.ed.insertText('q', 1, 'X'));
					a.receiveAll(t);
					b.receiveAll(d);
					expect(a.tree()).toBe('p:"ab"');
					b.receiveAll(a.capture(() => a.undo()));
				}
			)
		)) {
			expect(tree(o.ed)).toBe('p:"ab" q:"cXd"');
		}
	});
});

describe('5x. concurrent double delete of text (contract program history.concurrent-double-delete)', () => {
	// Found by the P1.3 contract programs: text deletion had no per-writer
	// mark (blocks do: D54, F-D18), so each peer's undo integrated its own
	// copy of the character both deleted. Fixed by per-writer text delete
	// marks (`text/deletes.ts`, fork patch P11); the delivery-order variants
	// are rows in `text-delete-marks.test.ts`.
	it('A and B delete the same character; both undo → `abc`, never a duplicated character', () => {
		for (const o of converge([{ id: 'p', text: 'abc' }], 2, ([a, b]) => {
			a.ed.deleteText('p', 1, 1);
			b.ed.deleteText('p', 1, 1);
			a.receiveAll(b.log);
			b.receiveAll(a.log);
			b.receiveAll(a.capture(() => a.undo()));
			a.receiveAll(b.capture(() => b.undo()));
		})) {
			expect(o.problems).toEqual([]);
			expect(o.ed.blockText('p')).toBe('abc');
		}
	});
});

describe('6. concurrent moves', () => {
	const xyz = [
		{ id: 'X', text: 'x' },
		{ id: 'Y', text: 'y' },
		{ id: 'Z', text: 'z' }
	];

	it('6a X into Y ‖ Y into X → acyclic, every block visible (MV05a)', () => {
		for (const o of one(
			converge(xyz, 2, ([a, b]) => {
				a.ed.nestBlock('X', 'Y');
				b.ed.nestBlock('Y', 'X');
			})
		)) {
			expect([...o.ed.order()].sort()).toEqual(['X', 'Y', 'Z']);
		}
	});

	it('6a3 three-way cycle X→Y, Y→Z, Z→X → acyclic, every block visible (MV05b)', () => {
		for (const o of one(
			converge(xyz, 3, ([a, b, c]) => {
				a.ed.nestBlock('X', 'Y');
				b.ed.nestBlock('Y', 'Z');
				c.ed.nestBlock('Z', 'X');
			})
		)) {
			expect([...o.ed.order()].sort()).toEqual(['X', 'Y', 'Z']);
		}
	});

	it('6b move X under Y ‖ delete Y → X takes Y’s slot (MV06b, native keeps X)', () => {
		for (const o of one(
			converge(xyz, 2, ([a, b]) => {
				a.ed.nestBlock('X', 'Y');
				b.ed.deleteBlocks(['Y']);
			})
		)) {
			expect(tree(o.ed)).toBe('X:"x" Z:"z"');
		}
	});

	it('6c move X under Y ‖ merge Y into Z → X stays visible', () => {
		for (const o of one(
			converge(
				[
					{ id: 'X', text: 'x' },
					{ id: 'Z', text: 'z' },
					{ id: 'Y', text: 'y' }
				],
				2,
				([a, b]) => {
					a.ed.nestBlock('X', 'Y');
					b.ed.mergeBackward('Y');
				}
			)
		)) {
			expect(o.ed.order()).toContain('X');
			expect(allText(o.ed)).toContain('x');
			expect(sorted(allText(o.ed))).toBe(sorted('xzy'));
		}
	});
});

describe('7. marks', () => {
	it('7a overlapping formats with different values converge', () => {
		one(
			converge([{ id: 'p', text: 'abcdefgh' }], 2, ([a, b]) => {
				a.ed.setMark('p', 0, 5, 'color', 'red');
				b.ed.setMark('p', 3, 5, 'color', 'blue');
			})
		);
	});

	it('7b bold a whole word ‖ the peer types inside the word → every character of the word is bold', () => {
		for (const o of one(
			converge([{ id: 'p', text: 'bold' }], 2, ([a, b]) => {
				a.ed.setMark('p', 0, 4, 'bold', true);
				b.ed.insertText('p', 2, 'X');
			})
		)) {
			expect(o.ed.blockJSON('p').content).toEqual([{ text: 'boXld', marks: { bold: true } }]);
		}
	});
});

/**
 * Deleting a block promotes its unselected children (`del.blocks.promote`,
 * the 2026-09-28 contract; the native probes' promote). Promotion is derived
 * when the document is read (UW-08): a block the deleter never saw — a
 * concurrent insertion, move or split-off tail under the deleted block —
 * takes its slot too, after the children the deleter saw.
 */
describe('9. promote children — deleting a parent promotes its children', () => {
	const family = [
		{ id: 'P', text: 'parent', children: [{ id: 'C', text: 'child' }] },
		{ id: 'N', text: 'next' }
	];

	it('9a delete P ‖ peer adds a child under P → C and D promoted (MV06b)', () => {
		for (const o of one(
			converge(family, 2, ([a, b]) => {
				a.ed.deleteBlocks(['P']);
				b.ed.insertBlock(
					{ parent: 'P', index: 1 },
					{ id: 'D', type: 'paragraph', content: [{ kind: 'text', text: 'new child' }] }
				);
			})
		)) {
			// As native: C and D promoted and kept, in P's order.
			expect(tree(o.ed)).toBe('C:"child" D:"new child" N:"next"');
		}
	});

	it('9a′ arch-v2’s promote: delete P keeping children ‖ peer adds a child under P → C and D promoted', () => {
		for (const o of one(
			converge(family, 2, ([a, b]) => {
				a.ed.deleteBlock('P', { keepChildren: true });
				b.ed.insertBlock(
					{ parent: 'P', index: 1 },
					{ id: 'D', type: 'paragraph', content: [{ kind: 'text', text: 'new child' }] }
				);
			})
		)) {
			expect(tree(o.ed)).toBe('C:"child" D:"new child" N:"next"');
		}
	});

	it('9b delete P and C ‖ peer moves N under P → N takes P’s slot (MV06b, native keeps N)', () => {
		for (const o of one(
			converge(family, 2, ([a, b]) => {
				a.ed.deleteBlocks(['P', 'C']);
				b.ed.moveBlock('N', { parent: 'P', index: 0 });
			})
		)) {
			expect(tree(o.ed)).toBe('N:"next"');
		}
	});

	it('9c delete P and C ‖ peer splits C → the split-off tail is rescued into P’s slot (ST02a, ST02d)', () => {
		for (const o of one(
			converge(
				[{ id: 'P', text: 'parent', children: [{ id: 'C', text: 'child' }] }],
				2,
				([a, b]) => {
					a.ed.deleteBlocks(['P', 'C']);
					b.ed.splitBlock('C', 2, 'C2');
				}
			)
		)) {
			// The tail of a deleted block is rescued (F-D20); P is deleted
			// too, so the tail takes P's slot.
			expect(tree(o.ed)).toBe('C2:"ild"');
		}
	});

	it('9d delete P ‖ peer splits P (children move to the tail) → the tail and the child survive (ST02a)', () => {
		for (const o of one(
			converge(
				[{ id: 'P', text: 'parent', children: [{ id: 'C', text: 'child' }] }],
				2,
				([a, b]) => {
					a.ed.deleteBlocks(['P']);
					b.ed.splitBlock('P', 3, 'T');
				}
			)
		)) {
			// The split-born tail is rescued. C has two concurrent moves — the
			// delete's promotion and the split's move to the tail — and the
			// placement's last-writer-wins (client order) picks one; nothing is lost.
			expect(['T:"ent"[C:"child"]', 'C:"child" T:"ent"']).toContain(tree(o.ed));
		}
	});
});

describe('split after move (single user, review-probes/split-moved)', () => {
	const cases = [
		[
			'move under a new parent',
			[
				{ id: 'P', text: 'abcd' },
				{ id: 'Q', text: 'q' }
			],
			(ed) => ed.nestBlock('P', 'Q'),
			'Q:"q"[P:"ab",N:"cd"]'
		],
		[
			'move to the front of the root',
			[
				{ id: 'A', text: 'a' },
				{ id: 'P', text: 'abcd' }
			],
			(ed) => ed.moveBlock('P', { parent: null, index: 0 }),
			'P:"ab" N:"cd" A:"a"'
		],
		[
			'move to the end of the root',
			[
				{ id: 'P', text: 'abcd' },
				{ id: 'A', text: 'a' }
			],
			(ed) => ed.moveBlock('P', { parent: null, index: 2 }),
			'A:"a" P:"ab" N:"cd"'
		],
		[
			'move before a sibling under a parent',
			[
				{ id: 'Q', text: 'q', children: [{ id: 'C', text: 'c' }] },
				{ id: 'P', text: 'abcd' }
			],
			(ed) => ed.moveBlock('P', { parent: 'Q', index: 0 }),
			'Q:"q"[P:"ab",N:"cd",C:"c"]'
		]
	] as const;
	for (const [name, seeds, setup, expected] of cases) {
		it(`split after ${name} keeps the tail right after the head`, () => {
			for (const cid of [11, 900, 55]) {
				const r = replica('X', seedUpdate(seeds), cid);
				expect(setup(r.ed).status).toBe('applied');
				expect(r.ed.splitBlock('P', 2, 'N').status).toBe('applied');
				expect(r.tree()).toBe(expected);
				r.destroy();
			}
		});
	}
});

describe('undo of a split after a peer split its moved child (review-probes/cycle-min)', () => {
	const seeds = [{ id: 'P', text: 'abcdef' }];

	it('concurrent: X undoes split+move ‖ Y splits P under T → converges, every character once', () => {
		for (const o of one(
			converge(seeds, 2, ([x, y]) => {
				const s = x.capture(() => {
					x.ed.splitBlock('P', 4, 'T'); // P "abcd" T "ef"
					x.ed.nestBlock('P', 'T'); // T "ef" [P "abcd"]
				});
				y.receiveAll(s);
				y.ed.splitBlock('P', 2, 'N'); // T [P "ab", N "cd"]
				x.undo(); // the move
				x.undo(); // the split
			})
		)) {
			expect(sorted(allText(o.ed))).toBe(sorted('abcdef'));
		}
	});

	it('sequential: the author can undo its own split after a peer split its child', () => {
		for (const o of one(
			converge(seeds, 2, ([x, y]) => {
				y.receiveAll(
					x.capture(() => {
						x.ed.splitBlock('P', 4, 'T');
						x.ed.nestBlock('P', 'T');
					})
				);
				x.receiveAll(y.capture(() => y.ed.splitBlock('P', 2, 'N')));
				expect(x.tree()).toBe('T:"ef"[P:"ab",N:"cd"]');
				expect(x.undo()).not.toBe(null);
				expect(x.undo()).not.toBe(null);
			})
		)) {
			expect(sorted(allText(o.ed))).toBe(sorted('abcdef'));
		}
	});
});

describe('capabilities under concurrency (review-probes/capabilities)', () => {
	const semantics = { roles: { divider: { void: true } } };

	it('retype to a void kind ‖ the peer types into the (empty) block → converges', () => {
		one(
			converge(
				[
					{ id: 'P', text: '' },
					{ id: 'Q', text: 'q' }
				],
				2,
				([a, b]) => {
					a.ed.setBlockType('P', 'divider');
					b.ed.insertText('P', 0, 'hi');
				},
				{ semantics }
			)
		);
	});

	const retypeNest = () =>
		converge(
			[
				{ id: 'P', text: 'p' },
				{ id: 'Q', text: 'q' }
			],
			2,
			([a, b]) => {
				a.ed.setBlockType('P', 'divider');
				b.ed.nestBlock('Q', 'P');
			},
			{ semantics }
		);

	// UW-21b: a void displays no children — one a peer nests concurrently
	// takes the void's slot at read time, on every replica.
	it('retype to a void kind ‖ the peer nests a block under it → P:"p" Q:"q"', () => {
		for (const o of one(retypeNest())) expect(tree(o.ed)).toBe('P:"p" Q:"q"');
	});

	it('retype a parent to a void kind ‖ the peer splits its child → the tail follows its head (UW-21b)', () => {
		for (const o of one(
			converge(
				[
					{ id: 'P', text: 'p', children: [{ id: 'K', text: 'kk' }] },
					{ id: 'Z', text: 'z' }
				],
				2,
				([a, b]) => {
					a.ed.setBlockType('P', 'divider');
					b.ed.splitBlock('K', 1, 'K2');
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('P:"p" K:"k" K2:"k" Z:"z"');
		}
	});

	it('retype to a void kind ‖ the peer nests under it, then undo of the retype → the child is back under it (UW-21b)', () => {
		for (const o of one(
			converge(
				[
					{ id: 'P', text: 'p' },
					{ id: 'Q', text: 'q' }
				],
				2,
				([a, b]) => {
					const retype = a.capture(() => a.ed.setBlockType('P', 'divider'));
					const nest = b.capture(() => b.ed.nestBlock('Q', 'P'));
					a.receiveAll(nest);
					b.receiveAll(retype);
					expect(a.tree()).toBe('P:"p" Q:"q"');
					expect(b.tree()).toBe('P:"p" Q:"q"');
					a.undo();
					expect(a.tree()).toBe('P:"p"[Q:"q"]');
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('P:"p"[Q:"q"]');
		}
	});

	it('retype a parent to a void kind ‖ the peer splits its child and nests a block under it, then undo (site table)', () => {
		for (const o of one(
			converge(
				[
					{ id: 'P', text: 'p', children: [{ id: 'K', text: 'kk' }] },
					{ id: 'N', text: 'n' }
				],
				2,
				([a, b]) => {
					const retype = a.capture(() => a.ed.setBlockType('P', 'divider'));
					const peer = b.capture(() => {
						b.ed.splitBlock('K', 1, 'K2');
						b.ed.nestBlock('N', 'P');
					});
					a.receiveAll(peer);
					b.receiveAll(retype);
					expect(a.tree()).toBe('P:"p" K:"k" K2:"k" N:"n"');
					expect(b.tree()).toBe('P:"p" K:"k" K2:"k" N:"n"');
					a.undo();
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('P:"p"[K:"k",K2:"k",N:"n"]');
		}
	});

	it('retype to a void kind ‖ the peer splits it → converges', () => {
		one(
			converge(
				[{ id: 'P', text: 'pp' }],
				2,
				([a, b]) => {
					a.ed.setBlockType('P', 'divider');
					b.ed.splitBlock('P', 1, 'N');
				},
				{ semantics }
			)
		);
	});
});

/**
 * Rescore 2026-09-30 low: a promoted block keeps no container-only kind. A
 * deleted island's children take the slot parent's default child type
 * (`deleteBlocks`, like an island merge); a child the deleter never saw —
 * a code line a peer adds concurrently — is promoted at read time and
 * displays the same way, so no `codeLine` shows outside a code block. The
 * stored kind is kept: undoing the delete shows it under its island again.
 * A block promoted out of a block that is not an island keeps its kind.
 */
describe('promoted blocks keep no container-only kind (rescore low)', () => {
	const semantics = {
		roles: { code: { island: true }, divider: { void: true } },
		rendersContent: { code: false },
		defaultChild: { code: 'codeLine' }
	};
	const typed = (ed) => {
		const show = (b) =>
			`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
		return ed.toJSON().children.map(show).join(' ');
	};
	const code = [
		{ id: 'C', type: 'code', text: '', children: [{ id: 'L1', type: 'codeLine', text: 'a' }] },
		{ id: 'N', text: 'n' }
	];
	const addLine = (ed) =>
		ed.insertBlock(
			{ parent: 'C', index: 1 },
			{ id: 'L2', type: 'codeLine', content: [{ kind: 'text', text: 'b' }] }
		);

	it('delete the code block ‖ the peer adds a code line → both lines display as paragraphs', () => {
		for (const o of one(
			converge(
				code,
				2,
				([a, b]) => {
					a.ed.deleteBlocks(['C']);
					addLine(b.ed);
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('L1:"a" L2:"b" N:"n"');
			expect(typed(o.ed)).toBe('L1:paragraph L2:paragraph N:paragraph');
			expect(o.ed.blockTypeOf('L2')).toBe('paragraph');
		}
	});

	it('…then undo of the delete → both lines are code lines in the code block again', () => {
		for (const o of one(
			converge(
				code,
				2,
				([a, b]) => {
					const del = a.capture(() => a.ed.deleteBlocks(['C']));
					const add = b.capture(() => addLine(b.ed));
					a.receiveAll(add);
					b.receiveAll(del);
					a.undo();
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('C:code[L1:codeLine,L2:codeLine] N:paragraph');
		}
	});

	/**
	 * RW-01: the reset is real, not display-only. After Ada's delete and
	 * Bob's line meet, Ada edits the promoted line; every replica shows the
	 * kind the edit meant.
	 */
	const promotedThen = (seeds, edit: (ed) => unknown) =>
		converge(
			seeds,
			2,
			([a, b]) => {
				const del = a.capture(() => a.ed.deleteBlocks(['C']));
				const add = b.capture(() => addLine(b.ed));
				a.receiveAll(add);
				b.receiveAll(del);
				expect(edit(a.ed).status).toBe('applied');
			},
			{ semantics }
		);

	it('RW-01 retype the promoted line → it shows the new kind', () => {
		for (const o of one(promotedThen(code, (ed) => ed.setBlockType('L2', 'heading')))) {
			expect(typed(o.ed)).toBe('L1:paragraph L2:heading N:paragraph');
		}
	});

	it('RW-01 move the promoted line → it stays a paragraph', () => {
		for (const o of one(
			promotedThen(code, (ed) => ed.moveBlock('L2', { parent: null, index: 0 }))
		)) {
			expect(tree(o.ed)).toBe('L2:"b" L1:"a" N:"n"');
			expect(typed(o.ed)).toBe('L2:paragraph L1:paragraph N:paragraph');
		}
	});

	for (const [name, edit] of Object.entries({
		retype: (ed) => ed.setBlockType('L2', 'heading'),
		move: (ed) => ed.moveBlock('L2', { parent: null, index: 0 })
	})) {
		it(`RW-01 ${name} the promoted line, then undo it and the delete → both code lines are back`, () => {
			for (const o of one(
				converge(
					code,
					2,
					([a, b]) => {
						const del = a.capture(() => a.ed.deleteBlocks(['C']));
						const add = b.capture(() => addLine(b.ed));
						a.receiveAll(add);
						b.receiveAll(del);
						edit(a.ed);
						a.undo();
						a.undo();
					},
					{ semantics }
				)
			)) {
				expect(typed(o.ed)).toBe('C:code[L1:codeLine,L2:codeLine] N:paragraph');
			}
		});
	}

	it('RW-01 Tab on the promoted line → it nests as a paragraph', () => {
		for (const o of one(promotedThen(code, (ed) => ed.nestBlock('L2', 'L1')))) {
			expect(typed(o.ed)).toBe('L1:paragraph[L2:paragraph] N:paragraph');
		}
	});

	it('RW-01 Shift+Tab on a line promoted under a parent → it outdents as the parent’s default child', () => {
		const nested = [{ id: 'Q', text: 'q', children: code.slice(0, 1) }, code[1]];
		for (const o of one(promotedThen(nested, (ed) => ed.unNestBlock('L2')))) {
			expect(tree(o.ed)).toBe('Q:"q"[L1:"a"] L2:"b" N:"n"');
			expect(typed(o.ed)).toBe('Q:paragraph[L1:paragraph] L2:paragraph N:paragraph');
		}
	});

	it('RW-01 split the promoted line → head and tail are paragraphs', () => {
		for (const o of one(promotedThen(code, (ed) => ed.splitBlock('L2', 1, 'L3')))) {
			expect(tree(o.ed)).toBe('L1:"a" L2:"b" L3:"" N:"n"');
			expect(typed(o.ed)).toBe('L1:paragraph L2:paragraph L3:paragraph N:paragraph');
		}
	});

	it('RW-01 delete the parent a line was promoted under → the line takes its slot as a paragraph', () => {
		const nested = [{ id: 'Q', text: 'q', children: code.slice(0, 1) }, code[1]];
		for (const o of one(promotedThen(nested, (ed) => ed.deleteBlocks(['Q'])))) {
			expect(tree(o.ed)).toBe('L1:"a" L2:"b" N:"n"');
			expect(typed(o.ed)).toBe('L1:paragraph L2:paragraph N:paragraph');
		}
	});

	it('RW-01 retype the parent a line was promoted under to a void kind → the line is shed as a paragraph', () => {
		const nested = [{ id: 'Q', text: 'q', children: code.slice(0, 1) }, code[1]];
		for (const o of one(promotedThen(nested, (ed) => ed.setBlockType('Q', 'divider')))) {
			expect(tree(o.ed)).toBe('Q:"q" L1:"a" L2:"b" N:"n"');
			expect(typed(o.ed)).toBe('Q:divider L1:paragraph L2:paragraph N:paragraph');
		}
	});

	const merged = [{ id: 'P', text: 'p' }, ...code];
	const merges = {
		Backspace: (ed) => ed.mergeBackward('C'),
		Delete: (ed) => ed.mergeForward('P')
	};
	for (const [key, mergeCode] of Object.entries(merges)) {
		it(`RW-01 merge the code block (${key}) ‖ the peer adds a code line → no code line outside it`, () => {
			for (const o of one(
				converge(
					merged,
					2,
					([a, b]) => {
						mergeCode(a.ed);
						addLine(b.ed);
					},
					{ semantics }
				)
			)) {
				expect(tree(o.ed)).toBe('P:"p"[L2:"b"] L1:"a" N:"n"');
				expect(typed(o.ed)).toBe('P:paragraph[L2:paragraph] L1:paragraph N:paragraph');
			}
		});
	}

	it('RW-01 engine merge of the code block (children adopt) ‖ the peer adds a code line → the survivor’s default children', () => {
		for (const o of one(
			converge(
				merged,
				2,
				([a, b]) => {
					a.ed.mergeBlocks('C', 'P');
					addLine(b.ed);
				},
				{ semantics }
			)
		)) {
			expect(tree(o.ed)).toBe('P:"p"[L1:"a",L2:"b"] N:"n"');
			expect(typed(o.ed)).toBe('P:paragraph[L1:paragraph,L2:paragraph] N:paragraph');
		}
	});

	it('RW-01 …then undo of the merge → both lines are code lines in the code block again', () => {
		for (const o of one(
			converge(
				merged,
				2,
				([a, b]) => {
					const merge = a.capture(() => a.ed.mergeBackward('C'));
					const add = b.capture(() => addLine(b.ed));
					a.receiveAll(add);
					b.receiveAll(merge);
					a.undo();
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('P:paragraph C:code[L1:codeLine,L2:codeLine] N:paragraph');
		}
	});

	it('delete a plain parent ‖ the peer adds a heading under it → the heading keeps its kind', () => {
		for (const o of one(
			converge(
				[{ id: 'P', text: 'p', children: [{ id: 'K', text: 'k' }] }],
				2,
				([a, b]) => {
					a.ed.deleteBlocks(['P']);
					b.ed.insertBlock(
						{ parent: 'P', index: 1 },
						{ id: 'H', type: 'heading', content: [{ kind: 'text', text: 'h' }] }
					);
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('K:paragraph H:heading');
		}
	});
});
