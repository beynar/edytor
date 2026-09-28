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
 * - promote-children (native §9): arch-v2 deletes the whole subtree of a
 *   deleted block (a block selection's nested members ride their ancestor,
 *   `deleteBlocks`); a concurrent child created under, or moved under, the
 *   deleted block hides with the subtree (MV06b). `deleteBlock(id,
 *   {keepChildren: true})` is arch-v2's promote, pinned here for the
 *   children the deleting peer saw.
 * - move under a concurrently deleted block (native 6b): hides with the
 *   subtree (MV06b), native keeps it.
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
				a.ed.deleteRange({ block: 'b0', offset: 2 }, { block: 'b2', offset: 1 }, 'fresh');
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

	it('5d undo of a block create after the peer typed in it — DIVERGENCE: the peer text dies with the block (conc.delete-wins-block, F-D19)', () => {
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
			// native: `peer text` survives. arch-v2: undo deletes `n`, and an insert
			// into a deleted block is deleted with it.
			expect(tree(o.ed)).toBe('p:"abc"');
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

	it('5f undo of a multi-line paste after the peer typed in a pasted line — DIVERGENCE: the pasted line dies with the peer text (F-D19)', () => {
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
			// native keeps `PEER`; arch-v2's undo deletes the pasted blocks and the
			// peer's insert dies with its block.
			expect(texts(o)).toEqual(['abcd']);
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

	it('6b move X under Y ‖ delete Y — DIVERGENCE: X hides with Y’s subtree (MV06b; native keeps X)', () => {
		for (const o of one(
			converge(xyz, 2, ([a, b]) => {
				a.ed.nestBlock('X', 'Y');
				b.ed.deleteBlocks(['Y']);
			})
		)) {
			expect(tree(o.ed)).toBe('Z:"z"');
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

describe('9. promote children — arch-v2 deletes subtrees (DIVERGENCE, pinned)', () => {
	const family = [
		{ id: 'P', text: 'parent', children: [{ id: 'C', text: 'child' }] },
		{ id: 'N', text: 'next' }
	];

	it('9a delete P ‖ peer adds a child under P → P’s subtree, the new child included, is gone (MV06b)', () => {
		for (const o of one(
			converge(family, 2, ([a, b]) => {
				a.ed.deleteBlocks(['P']);
				b.ed.insertBlock(
					{ parent: 'P', index: 1 },
					{ id: 'D', type: 'paragraph', content: [{ kind: 'text', text: 'new child' }] }
				);
			})
		)) {
			// native: C and D promoted and kept.
			expect(tree(o.ed)).toBe('N:"next"');
		}
	});

	it('9a′ arch-v2’s promote: delete P keeping children ‖ peer adds a child under P → C promoted, D hides with P', () => {
		for (const o of one(
			converge(family, 2, ([a, b]) => {
				a.ed.deleteBlock('P', { keepChildren: true });
				b.ed.insertBlock(
					{ parent: 'P', index: 1 },
					{ id: 'D', type: 'paragraph', content: [{ kind: 'text', text: 'new child' }] }
				);
			})
		)) {
			expect(tree(o.ed)).toBe('C:"child" N:"next"');
		}
	});

	it('9b delete P and C ‖ peer moves N under P → N hides with the subtree (MV06b; native keeps N)', () => {
		for (const o of one(
			converge(family, 2, ([a, b]) => {
				a.ed.deleteBlocks(['P', 'C']);
				b.ed.moveBlock('N', { parent: 'P', index: 0 });
			})
		)) {
			expect(tree(o.ed)).toBe('');
		}
	});

	it('9c delete P and C ‖ peer splits C → the split-born sibling hides with the subtree (ST02d)', () => {
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
			expect(tree(o.ed)).toBe('');
		}
	});

	it('9d delete P ‖ peer splits P (children move to the tail) → the tail survives with the children (ST02a)', () => {
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
			// Same answer as the native probe: the split-born tail is rescued and
			// carries the children the split moved to it.
			expect(tree(o.ed)).toBe('T:"ent"[C:"child"]');
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

	it('retype to a void kind ‖ the peer nests a block under it → converges', () => {
		one(
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
			)
		);
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
