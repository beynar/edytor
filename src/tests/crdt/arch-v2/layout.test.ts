/**
 * Columns, phase C1 (`docs/columns-plan.md`): the `layout.*` rows of
 * `docs/editor-delete-contract.md`, at the document layer. A layout is a
 * kind whose role says `layout: true`; its default child is its item (a
 * column). Every `converge` row runs under the plan §8 multi-replica rule
 * (three client-id assignments, both delivery orders, duplicate delivery,
 * binary reload: display equality across every replica, observer and
 * reload) and every replica is held to `wellFormed` — `layout-shape`
 * included — after every write and delivery. Expected trees are
 * hand-written from the contract rows.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { allText, converge, tree } from './replica-harness.js';
import { loadDocument } from '../../../lib/crdt/index.js';
import * as crdt from '../../../lib/crdt/index.js';
import {
	codeKinds,
	defaultSemantics,
	imageKinds,
	richTextKinds,
	semanticsOf
} from '../../../lib/crdt/semantics.js';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';

/** The layout rows the plan names (`layoutKinds` in `crdt/semantics.ts`, §4.1). */
const LAYOUT = {
	columns: { layout: true, rendersContent: false, defaultChild: 'column' },
	column: { rendersContent: false }
};
/** The bundled kinds and the layout. */
const semantics = semanticsOf(richTextKinds, codeKinds, imageKinds, LAYOUT);
/** The same kinds with no layout role: what a role-less replica reads of the stored tree. */
const plain = semanticsOf(richTextKinds, codeKinds, imageKinds, {
	columns: { rendersContent: false, defaultChild: 'column' },
	column: { rendersContent: false }
});

/** `id:type[children]` of the visible tree, a block id an op minted shown as `NEW`. */
const typed = (ed) => {
	const show = (b) =>
		`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
	return ed
		.toJSON()
		.children.map(show)
		.join(' ')
		.replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW');
};
const shape = (ed) => tree(ed).replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW');

/** Every outcome converged and well-formed. */
const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

/** The stored tree, read by a replica without the layout role: what the writes wrote. */
const stored = (o) => {
	const doc = loadDocument(Y.encodeStateAsUpdate(o.reps[0].doc), { semantics: plain });
	const out = typed(doc.facade);
	doc.destroy();
	return out;
};

const para = (id: string, text = id.toLowerCase(), children = []) => ({ id, text, children });
const col = (id: string, ...children) => ({ id, type: 'column', text: '', children });
const cols = (id: string, ...items) => ({ id, type: 'columns', text: '', children: items });
const content = (text: string) => [{ kind: 'text', text }];

/** `P, C:columns[K1:column[A, A2], K2:column[B]], Z` — the contract's `C`. */
const SEED = [
	para('P'),
	cols('C', col('K1', para('A'), para('A2')), col('K2', para('B'))),
	para('Z')
];
const BEFORE =
	'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]] Z:paragraph';

/**
 * A single-replica row: `op` applies, one undo restores the tree, redo
 * brings it back; the displayed kinds are `kindsOut` everywhere and, when
 * given, the texts `shapeOut`. `writes`: the stored tree equals the display
 * (the write wrote what the read-time rule shows).
 */
const row = (
	seed,
	op: (ed) => { status: string },
	kindsOut: string,
	{ shapeOut, writes = true }: { shapeOut?: string; writes?: boolean } = {}
) => {
	for (const o of one(
		converge(
			seed,
			1,
			([a]) => {
				const before = typed(a.ed) + ' ' + tree(a.ed);
				expect(op(a.ed).status).toBe('applied');
				a.undo();
				expect(typed(a.ed) + ' ' + tree(a.ed)).toBe(before);
				a.redo();
			},
			{ semantics }
		)
	)) {
		expect(typed(o.ed)).toBe(kindsOut);
		if (shapeOut !== undefined) expect(shape(o.ed)).toBe(shapeOut);
		if (writes) expect(stored(o)).toBe(kindsOut);
	}
};

/** A read-only row: the seed displays as `kindsOut` on every replica. */
const shows = (seed, kindsOut: string) => {
	for (const o of one(converge(seed, 1, () => {}, { semantics })))
		expect(typed(o.ed)).toBe(kindsOut);
};

describe('layout semantics: the role is data (C1)', () => {
	it('layoutKinds/layoutSemantics are the plan’s rows; defaultSemantics holds them (C5)', () => {
		expect(crdt.layoutKinds).toEqual(LAYOUT);
		expect(crdt.layoutSemantics).toEqual(semanticsOf(LAYOUT));
		expect(defaultSemantics.roles.columns).toEqual({ layout: true });
		expect(defaultSemantics.roles.column).toEqual({});
		expect(defaultSemantics.defaultChild.columns).toBe('column');
		expect(defaultSemantics.rendersContent.columns).toBe(false);
		expect(defaultSemantics.rendersContent.column).toBe(false);
	});

	it('isLayout / isLayoutItem read the roles, not names', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => {
					expect(a.ed.isLayout('C')).toBe(true);
					expect(a.ed.isLayout('K1')).toBe(false);
					expect(a.ed.isLayoutItem('K1')).toBe(true);
					expect(a.ed.isLayoutItem('A')).toBe(false);
					expect(a.ed.isLayoutItem('C')).toBe(false);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(BEFORE);
	});
});

describe('layout.fits: a layout holds only its items', () => {
	it('fits, canPlace and moveBlocks refuse anything but a column in a layout', () => {
		const seed = [
			...SEED,
			{
				id: 'U',
				type: 'unordered-list',
				text: '',
				children: [{ id: 'I', type: 'list-item', text: 'i' }]
			},
			cols('C2', col('L1', para('X')), col('L2', para('Y')))
		];
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.fits('C', 'column')).toBe(true);
					expect(a.ed.fits('C', 'columns')).toBe(false);
					expect(a.ed.fits('C', 'paragraph')).toBe(false);
					// The containers-of-items clause still holds where the item renders content.
					expect(a.ed.fits('U', 'unordered-list')).toBe(true);
					expect(a.ed.canPlace(['Z'], 'C')).toBe(false);
					expect(a.ed.moveBlocks(['Z'], { parent: 'C', index: 1 }).status).toBe('refused');
					expect(a.ed.moveBlocks(['C2'], { parent: 'C', index: 1 }).status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toMatch(/^P:paragraph C:columns\[K1:column/);
	});

	it('Tab on the paragraph after a layout nests it in the last column', () =>
		row(
			SEED,
			(ed) => ed.nestBlock('Z', 'C'),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph,Z:paragraph]]'
		));
});

describe('layout.only-items: a layout displays only its items (read)', () => {
	it('a paragraph stored directly in a layout shows right after it', () =>
		shows(
			[para('P'), cols('C', col('K1', para('A')), para('X'), col('K2', para('B'))), para('Z')],
			'P:paragraph C:columns[K1:column[A:paragraph],K2:column[B:paragraph]] X:paragraph Z:paragraph'
		));

	it('a raw insertBlocks into a layout ‖ a peer types in a column → the block shows after it', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					const x = [{ id: 'X', type: 'paragraph', content: content('x') }];
					expect(a.ed.insertBlocks({ parent: 'C', index: 1 }, x).status).toBe('applied');
					expect(b.ed.insertText('A', 1, '!').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe(`${BEFORE.replace(' Z:', ' X:paragraph Z:')}`);
			expect(shape(o.ed)).toBe('P:"p" C:""[K1:""[A:"a!",A2:"a2"],K2:""[B:"b"]] X:"x" Z:"z"');
		}
	});

	it('a column retyped to a paragraph leaves the layout, which then dissolves', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => expect(a.ed.setBlockType('K2', 'paragraph').status).toBe('applied'),
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(
				'P:paragraph A:paragraph A2:paragraph K2:paragraph[B:paragraph] Z:paragraph'
			);
	});

	it('a code line stored directly in a layout shows after it as a paragraph (AW-05)', () =>
		shows(
			[
				cols(
					'C',
					col('K1', para('A')),
					{ id: 'L', type: 'codeLine', text: 'let x' },
					col('K2', para('B'))
				)
			],
			'C:columns[K1:column[A:paragraph],K2:column[B:paragraph]] L:paragraph'
		));
});

describe('layout.empty-item: an item that displays no child does not display (read)', () => {
	it('an empty column between two columns does not show', () =>
		shows(
			[cols('C', col('K1', para('A')), col('K2'), col('K3', para('B')))],
			'C:columns[K1:column[A:paragraph],K3:column[B:paragraph]]'
		));

	it('a column holding only a deleted block does not show (a peer deletes ‖ a peer adds a column)', () => {
		const seed = [cols('C', col('K1', para('A')), col('K2', para('B')), col('K3', para('D')))];
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					// Ada empties K2 (it goes, two columns stay) while Bob adds a block to K3.
					expect(a.ed.deleteBlocks(['B']).status).toBe('applied');
					const e = [{ id: 'E', type: 'paragraph', content: content('e') }];
					expect(b.ed.insertBlocks({ parent: 'K3', index: 1 }, e).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(
				'C:columns[K1:column[A:paragraph],K3:column[D:paragraph,E:paragraph]]'
			);
	});
});

describe('layout.single: a layout displaying one item or none does not display (read)', () => {
	it('one column: its blocks show in the layout’s slot', () =>
		shows(
			[para('P'), cols('C', col('K1', para('A'), para('A2'))), para('Z')],
			'P:paragraph A:paragraph A2:paragraph Z:paragraph'
		));

	it('one column and an empty one: the same', () =>
		shows(
			[para('P'), cols('C', col('K1', para('A')), col('K2')), para('Z')],
			'P:paragraph A:paragraph Z:paragraph'
		));

	it('no column: nothing shows', () =>
		shows([para('P'), cols('C'), para('Z')], 'P:paragraph Z:paragraph'));

	it('a one-column layout in a list: its paragraph shows as the list’s item', () =>
		shows(
			[{ id: 'U', type: 'unordered-list', text: '', children: [cols('C', col('K1', para('A')))] }],
			'U:unordered-list[A:list-item]'
		));
});

describe('layout.bare-item: an item outside a layout does not display (read)', () => {
	it('a column at the root shows its blocks only', () =>
		shows(
			[para('P'), col('K', para('A'), para('A2')), para('Z')],
			'P:paragraph A:paragraph A2:paragraph Z:paragraph'
		));

	it('a column inside a column shows its blocks in the outer column', () =>
		shows(
			[cols('C', col('K1', para('A'), col('KK', para('X'))), col('K2', para('B')))],
			'C:columns[K1:column[A:paragraph,X:paragraph],K2:column[B:paragraph]]'
		));
});

describe('layout.dissolving: the writes that leave those states', () => {
	it('deleting the only block of a column → the column goes, the layout dissolves', () =>
		row(SEED, (ed) => ed.deleteBlocks(['B']), 'P:paragraph A:paragraph A2:paragraph Z:paragraph'));

	it('deleting every block of the first column → the same, the second column’s blocks stay', () =>
		row(SEED, (ed) => ed.deleteBlocks(['A', 'A2']), 'P:paragraph B:paragraph Z:paragraph'));

	it('of three columns, one emptied → two stay', () =>
		row(
			[cols('C', col('K1', para('A')), col('K2', para('B')), col('K3', para('D')))],
			(ed) => ed.deleteBlocks(['B']),
			'C:columns[K1:column[A:paragraph],K3:column[D:paragraph]]'
		));

	it('Ada deletes B ‖ Bob types in A2 → the layout dissolves, Bob’s text stays', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['B']).status).toBe('applied');
					expect(b.ed.insertText('A2', 2, '!').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toBe('P:"p" A:"a" A2:"a2!" Z:"z"');
	});

	it('Ada deletes B ‖ Bob adds a block to its column → Bob’s block follows the dissolved layout’s', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['B']).status).toBe('applied');
					const b2 = [{ id: 'B2', type: 'paragraph', content: content('b2') }];
					expect(b.ed.insertBlocks({ parent: 'K2', index: 1 }, b2).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toBe('P:"p" A:"a" A2:"a2" B2:"b2" Z:"z"');
	});

	it('a move out of a column (drag out) → the layout dissolves', () =>
		row(
			SEED,
			(ed) => ed.moveBlocks(['B'], { parent: null, index: 3 }),
			'P:paragraph A:paragraph A2:paragraph Z:paragraph B:paragraph'
		));

	it('Ada drags B out (dissolve) ‖ Bob moves Z into B’s column → Z follows the layout’s blocks', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.moveBlocks(['B'], { parent: null, index: 0 }).status).toBe('applied');
					expect(b.ed.moveBlocks(['Z'], { parent: 'K2', index: 1 }).status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe('B:paragraph P:paragraph A:paragraph A2:paragraph Z:paragraph');
			expect(allText(o.ed)).toBe('bpaa2z');
		}
	});
});

describe('layout.dissolving: deleting a column or a layout', () => {
	it('deleting a column → its blocks right after the layout, which dissolves', () =>
		row(
			SEED,
			(ed) => ed.deleteBlocks(['K2']),
			'P:paragraph A:paragraph A2:paragraph B:paragraph Z:paragraph'
		));

	it('deleting one of three columns → its blocks right after the layout', () =>
		row(
			[
				para('P'),
				cols('C', col('K1', para('A')), col('K2', para('B')), col('K3', para('D'))),
				para('Z')
			],
			(ed) => ed.deleteBlocks(['K2']),
			'P:paragraph C:columns[K1:column[A:paragraph],K3:column[D:paragraph]] B:paragraph Z:paragraph'
		));

	it('Ada deletes a column ‖ Bob adds a block to it → Bob’s block follows', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['K2']).status).toBe('applied');
					const b2 = [{ id: 'B2', type: 'paragraph', content: content('b2') }];
					expect(b.ed.insertBlocks({ parent: 'K2', index: 1 }, b2).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toBe('P:"p" A:"a" A2:"a2" B:"b" B2:"b2" Z:"z"');
	});

	it('deleting a layout → its blocks take its slot, in reading order, with their kinds', () =>
		row(
			[
				para('P'),
				cols(
					'C',
					col('K1', para('A'), para('A2')),
					col('K2', { id: 'H', type: 'heading', text: 'h' })
				),
				para('Z')
			],
			(ed) => ed.deleteBlocks(['C']),
			'P:paragraph A:paragraph A2:paragraph H:heading Z:paragraph'
		));

	it('Ada deletes the layout ‖ Bob adds a column → the column’s blocks follow, no column shows', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['C']).status).toBe('applied');
					const k3 = [
						{
							id: 'K3',
							type: 'column',
							children: [{ id: 'D', type: 'paragraph', content: content('d') }]
						}
					];
					expect(b.ed.insertBlocks({ parent: 'C', index: 2 }, k3).status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe(
				'P:paragraph A:paragraph A2:paragraph B:paragraph D:paragraph Z:paragraph'
			);
		}
	});
});

describe('layout.merge: merges cross columns in reading order (D4)', () => {
	it('Backspace at the second column’s first block → it joins the first column’s last line', () =>
		row(SEED, (ed) => ed.mergeBackward('B'), 'P:paragraph A:paragraph A2:paragraph Z:paragraph', {
			shapeOut: 'P:"p" A:"a" A2:"a2b" Z:"z"'
		}));

	it('Backspace at the first column’s first block → it joins the line before the layout', () =>
		row(
			SEED,
			(ed) => ed.mergeBackward('A'),
			'P:paragraph C:columns[K1:column[A2:paragraph],K2:column[B:paragraph]] Z:paragraph',
			{ shapeOut: 'P:"pa" C:""[K1:""[A2:"a2"],K2:""[B:"b"]] Z:"z"' }
		));

	it('…of a one-block first column → the column goes, the layout dissolves', () =>
		row(
			[para('P'), cols('C', col('K1', para('A')), col('K2', para('B'))), para('Z')],
			(ed) => ed.mergeBackward('A'),
			'P:paragraph B:paragraph Z:paragraph',
			{ shapeOut: 'P:"pa" B:"b" Z:"z"' }
		));

	it('the merged block’s children stay in its column', () =>
		row(
			[
				para('P'),
				cols('C', col('K1', para('A', 'a', [para('X')])), col('K2', para('B'))),
				para('Z')
			],
			(ed) => ed.mergeBackward('A'),
			'P:paragraph C:columns[K1:column[X:paragraph],K2:column[B:paragraph]] Z:paragraph',
			{ shapeOut: 'P:"pa" C:""[K1:""[X:"x"],K2:""[B:"b"]] Z:"z"' }
		));

	it('an empty first block → removed, the previous line unchanged', () =>
		row(
			[para('P'), cols('C', col('K1', para('A')), col('K2', para('B', ''))), para('Z')],
			(ed) => ed.mergeBackward('B'),
			'P:paragraph A:paragraph Z:paragraph',
			{ shapeOut: 'P:"p" A:"a" Z:"z"' }
		));

	it('no line before the layout, or one that takes no merge → refused', () => {
		const first = [cols('C', col('K1', para('A')), col('K2', para('B')))];
		const afterVoid = [{ id: 'D', type: 'divider', text: '' }, ...first];
		for (const seed of [first, afterVoid])
			for (const o of one(
				converge(seed, 1, ([a]) => expect(a.ed.mergeBackward('A').status).toBe('refused'), {
					semantics
				})
			))
				expect(typed(o.ed)).toMatch(/C:columns\[K1:column\[A:paragraph\],K2/);
	});

	it('Delete at a column’s last line pulls the next column’s first line', () =>
		row(SEED, (ed) => ed.mergeForward('A2'), 'P:paragraph A:paragraph A2:paragraph Z:paragraph', {
			shapeOut: 'P:"p" A:"a" A2:"a2b" Z:"z"'
		}));

	it('Delete at the line before the layout pulls the first column’s first line', () =>
		row(
			SEED,
			(ed) => ed.mergeForward('P'),
			'P:paragraph C:columns[K1:column[A2:paragraph],K2:column[B:paragraph]] Z:paragraph',
			{ shapeOut: 'P:"pa" C:""[K1:""[A2:"a2"],K2:""[B:"b"]] Z:"z"' }
		));

	it('Backspace at the block after the layout joins the last column’s last line', () =>
		row(
			SEED,
			(ed) => ed.mergeBackward('Z'),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]]',
			{ shapeOut: 'P:"p" C:""[K1:""[A:"a",A2:"a2"],K2:""[B:"bz"]]' }
		));

	it('a text range across columns joins its ends; the emptied column goes, the layout dissolves', () =>
		row(
			SEED,
			(ed) => ed.deleteRange({ block: 'A2', offset: 1 }, { block: 'B', offset: 0 }),
			'P:paragraph A:paragraph A2:paragraph Z:paragraph',
			{ shapeOut: 'P:"p" A:"a" A2:"ab" Z:"z"' }
		));

	it('the outdent stays refused (ZW-14)', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => {
					expect(a.ed.unNestBlock('A2').status).toBe('refused');
					expect(a.ed.unNestBlock('B').status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(BEFORE);
	});

	it('Ada merges B back ‖ Bob types in B → Bob’s text joins the line', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.mergeBackward('B').status).toBe('applied');
					expect(b.ed.insertText('B', 1, '!').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toBe('P:"p" A:"a" A2:"a2b!" Z:"z"');
	});
});

describe('layout.flow-slot: a flow over selected blocks fills their slot first', () => {
	const run = (id, text) => ({ id, content: text ? content(text) : [] });
	it('replacing the only block of a column → the column stays, the line takes its place', () =>
		row(
			SEED,
			(ed) => ed.apply(ed.prepare.insertFlow({ replace: ['B'] }, { lines: [run('X', 'x')] })),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[X:paragraph]] Z:paragraph',
			{ shapeOut: 'P:"p" C:""[K1:""[A:"a",A2:"a2"],K2:""[X:"x"]] Z:"z"' }
		));

	it('replacing every block of the first column → the same', () =>
		row(
			SEED,
			(ed) => ed.apply(ed.prepare.insertFlow({ replace: ['A', 'A2'] }, { lines: [run('X', '')] })),
			'P:paragraph C:columns[K1:column[X:paragraph],K2:column[B:paragraph]] Z:paragraph'
		));

	it('a copied layout replacing a column’s only block lands as its blocks (flow.layout)', () =>
		row(
			SEED,
			(ed) =>
				ed.apply(
					ed.prepare.insertFlow(
						{ replace: ['B'] },
						{
							lines: [
								{
									id: 'L',
									type: 'columns',
									children: [
										{
											id: 'L1',
											type: 'column',
											children: [{ id: 'X', type: 'paragraph', content: content('x') }]
										},
										{
											id: 'L2',
											type: 'column',
											children: [{ id: 'Y', type: 'paragraph', content: content('y') }]
										}
									]
								}
							]
						}
					)
				),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[X:paragraph,Y:paragraph]] Z:paragraph'
		));

	it('replacing a column’s block ‖ a peer deletes its other column → one column left, it dissolves', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(
						a.ed.apply(a.ed.prepare.insertFlow({ replace: ['B'] }, { lines: [run('X', 'x')] }))
							.status
					).toBe('applied');
					expect(b.ed.deleteBlocks(['K1']).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('P:paragraph A:paragraph A2:paragraph X:paragraph Z:paragraph');
	});
});

describe('layout.wrap: wrapInLayout(ids, kind?, columns?) — Turn into N columns', () => {
	const flat = [para('P'), para('Q', 'q', [para('Q1')]), para('R'), ...SEED.slice(1)];
	const AFTER = 'C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]] Z:paragraph';

	it('two to five siblings: one layout at the first one’s place, one block per column, children kept', () => {
		row(
			flat,
			(ed) => ed.wrapInLayout(['P', 'Q', 'R']),
			`NEW:columns[NEW:column[P:paragraph],NEW:column[Q:paragraph[Q1:paragraph]],NEW:column[R:paragraph]] ${AFTER}`
		);
		row(
			flat,
			(ed) => ed.wrapInLayout(['R', 'P']),
			`NEW:columns[NEW:column[P:paragraph],NEW:column[R:paragraph]] Q:paragraph[Q1:paragraph] ${AFTER}`
		);
	});

	it('one block into N columns: it fills column 1, each further column one empty paragraph (Notion)', () => {
		row(
			flat,
			(ed) => ed.wrapInLayout(['Q'], undefined, 3),
			`P:paragraph NEW:columns[NEW:column[Q:paragraph[Q1:paragraph]],NEW:column[NEW:paragraph],NEW:column[NEW:paragraph]] R:paragraph ${AFTER}`,
			{
				shapeOut: `P:"p" NEW:""[NEW:""[Q:"q"[Q1:"q1"]],NEW:""[NEW:""],NEW:""[NEW:""]] R:"r" C:""[K1:""[A:"a",A2:"a2"],K2:""[B:"b"]] Z:"z"`
			}
		);
		row(
			flat,
			(ed) => ed.wrapInLayout(['P', 'R'], 'columns', 4),
			`NEW:columns[NEW:column[P:paragraph],NEW:column[R:paragraph],NEW:column[NEW:paragraph],NEW:column[NEW:paragraph]] Q:paragraph[Q1:paragraph] ${AFTER}`
		);
	});

	it('siblings apart: the layout takes the first one’s place', () =>
		row(
			SEED,
			(ed) => ed.wrapInLayout(['P', 'Z']),
			'NEW:columns[NEW:column[P:paragraph],NEW:column[Z:paragraph]] C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]]'
		));

	it('nested siblings wrap where they are (under a toggle)', () =>
		row(
			[{ id: 'T', type: 'toggle', text: 't', children: [para('X'), para('Y')] }],
			(ed) => ed.wrapInLayout(['X', 'Y']),
			'T:toggle[NEW:columns[NEW:column[X:paragraph],NEW:column[Y:paragraph]]]'
		));

	it('refusals: one block, not siblings, in a column (D2), a layout among them, list items, no layout kind', () => {
		for (const o of one(
			converge(
				[
					...flat,
					{
						id: 'L',
						type: 'unordered-list',
						text: '',
						children: [
							{ id: 'i1', type: 'list-item', text: 'i1' },
							{ id: 'i2', type: 'list-item', text: 'i2' }
						]
					}
				],
				1,
				([a]) => {
					expect(a.ed.wrapInLayout(['P']).status).toBe('refused');
					expect(a.ed.wrapInLayout([]).status).toBe('refused');
					expect(a.ed.wrapInLayout([], undefined, 2).status).toBe('refused');
					expect(a.ed.wrapInLayout(['P'], undefined, 1).status).toBe('refused');
					expect(a.ed.wrapInLayout(['P'], undefined, 2.5).status).toBe('refused');
					expect(a.ed.wrapInLayout(['P', 'Q', 'R'], undefined, 2).status).toBe('refused');
					expect(a.ed.wrapInLayout(['A'], undefined, 2).status).toBe('refused');
					expect(a.ed.wrapInLayout(['i1'], undefined, 2).status).toBe('refused');
					expect(a.ed.wrapInLayout(['P', 'Q1']).status).toBe('refused');
					expect(a.ed.wrapInLayout(['A', 'A2']).status).toBe('refused');
					expect(a.ed.wrapInLayout(['P', 'C']).status).toBe('refused');
					expect(a.ed.wrapInLayout(['i1', 'i2']).status).toBe('refused');
					expect(a.ed.wrapInLayout(['P', 'Q'], 'paragraph').status).toBe('refused');
					expect(a.ed.wrapInLayout(['P', 'P']).status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toMatch(/^P:paragraph Q:paragraph/);
	});

	it('Ada turns Q into 2 columns ‖ Bob types in Q → Bob’s text is in column 1, column 2 empty', () => {
		for (const o of one(
			converge(
				flat,
				2,
				([a, b]) => {
					expect(a.ed.wrapInLayout(['Q'], undefined, 2).status).toBe('applied');
					expect(b.ed.insertText('Q', 1, '!').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toMatch(
				/^P:"p" NEW:""\[NEW:""\[Q:"q!"\[Q1:"q1"\]\],NEW:""\[NEW:""\]\] R:"r"/
			);
	});

	it('Ada wraps P, Q ‖ Bob types in Q → Bob’s text is in Q’s column', () => {
		for (const o of one(
			converge(
				flat,
				2,
				([a, b]) => {
					expect(a.ed.wrapInLayout(['P', 'Q']).status).toBe('applied');
					expect(b.ed.insertText('Q', 1, '!').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(shape(o.ed)).toMatch(/^NEW:""\[NEW:""\[P:"p"\],NEW:""\[Q:"q!"\[Q1:"q1"\]\]\] R:"r"/);
	});
});

describe('layout.nest: no layout inside a column, by gesture (D2)', () => {
	const seed = [
		...SEED,
		cols('C2', col('L1', para('X')), col('L2', para('Y'))),
		para('T', 't', [cols('C3', col('M1', para('V')), col('M2', para('W')))])
	];

	it('a move of a layout, or of a block holding one, into a column → refused', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.canPlace(['C2'], 'K1')).toBe(false);
					expect(a.ed.moveBlocks(['C2'], { parent: 'K1', index: 0 }).status).toBe('refused');
					expect(a.ed.nestBlock('C2', 'A').status).toBe('refused');
					expect(a.ed.moveBlocks(['T'], { parent: 'K2', index: 1 }).status).toBe('refused');
					// A column holds any other block.
					expect(a.ed.canPlace(['Z'], 'K1')).toBe(true);
					expect(a.ed.canPlace(['C2'], null)).toBe(true);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toMatch(/^P:paragraph C:columns\[K1:column\[A:paragraph,A2:paragraph\]/);
	});

	it('a layout an explicit write puts in a column displays as it is (no flatten)', () =>
		row(
			SEED,
			(ed) =>
				ed.insertBlocks({ parent: 'K1', index: 2 }, [
					{
						id: 'C2',
						type: 'columns',
						children: [
							{
								id: 'L1',
								type: 'column',
								children: [{ id: 'X', type: 'paragraph', content: content('x') }]
							},
							{
								id: 'L2',
								type: 'column',
								children: [{ id: 'Y', type: 'paragraph', content: content('y') }]
							}
						]
					}
				]),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph,C2:columns[L1:column[X:paragraph],L2:column[Y:paragraph]]],K2:column[B:paragraph]] Z:paragraph'
		));
});

describe('layout.place-beside: placeBeside(ids, target, side, kind?)', () => {
	it('beside a block at the root → a new layout wraps it, right or left', () => {
		row(
			SEED,
			(ed) => ed.placeBeside(['Z'], 'P', 'right'),
			`NEW:columns[NEW:column[P:paragraph],NEW:column[Z:paragraph]] ${BEFORE.slice(12, -12)}`
		);
		row(
			SEED,
			(ed) => ed.placeBeside(['Z'], 'P', 'left'),
			`NEW:columns[NEW:column[Z:paragraph],NEW:column[P:paragraph]] ${BEFORE.slice(12, -12)}`
		);
	});

	it('beside a block in a column → a new column beside that column', () => {
		row(
			SEED,
			(ed) => ed.placeBeside(['Z'], 'A2', 'right'),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],NEW:column[Z:paragraph],K2:column[B:paragraph]]'
		);
		row(
			SEED,
			(ed) => ed.placeBeside(['Z'], 'A', 'left'),
			'P:paragraph C:columns[NEW:column[Z:paragraph],K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]]'
		);
	});

	it('a column stands for itself, a layout for its edge', () => {
		row(
			SEED,
			(ed) => ed.placeBeside(['Z'], 'K2', 'right'),
			'P:paragraph C:columns[K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph],NEW:column[Z:paragraph]]'
		);
		row(
			SEED,
			(ed) => ed.placeBeside(['P'], 'C', 'left'),
			'C:columns[NEW:column[P:paragraph],K1:column[A:paragraph,A2:paragraph],K2:column[B:paragraph]] Z:paragraph'
		);
	});

	it('several blocks go into one new column, in order', () =>
		row(
			SEED,
			(ed) => ed.placeBeside(['P', 'Z'], 'B', 'left'),
			'C:columns[K1:column[A:paragraph,A2:paragraph],NEW:column[P:paragraph,Z:paragraph],K2:column[B:paragraph]]'
		));

	it('a list item stands for its list: at the root it is wrapped, in a column beside it', () => {
		const list = (...children) => ({ id: 'U', type: 'unordered-list', text: '', children });
		const item = (id) => ({ id, type: 'list-item', text: id.toLowerCase() });
		row(
			[list(item('I1'), item('I2')), para('Z')],
			(ed) => ed.placeBeside(['Z'], 'I2', 'right'),
			'NEW:columns[NEW:column[U:unordered-list[I1:list-item,I2:list-item]],NEW:column[Z:paragraph]]'
		);
		row(
			[cols('C', col('K1', list(item('I1'))), col('K2', para('B'))), para('Z')],
			(ed) => ed.placeBeside(['Z'], 'I1', 'right'),
			'C:columns[K1:column[U:unordered-list[I1:list-item]],NEW:column[Z:paragraph],K2:column[B:paragraph]]'
		);
	});

	it('a toggle’s or a callout’s child is wrapped where it is; a nested block too', () => {
		const toggle = (id, ...children) => ({ id, type: 'toggle', text: 't', children });
		const callout = (id, ...children) => ({ id, type: 'callout', text: 'c', children });
		row(
			[toggle('T', para('T1'), para('T2')), para('Z')],
			(ed) => ed.placeBeside(['Z'], 'T1', 'right'),
			'T:toggle[NEW:columns[NEW:column[T1:paragraph],NEW:column[Z:paragraph]],T2:paragraph]'
		);
		row(
			[callout('O', para('O1')), para('Z')],
			(ed) => ed.placeBeside(['Z'], 'O1', 'left'),
			'O:callout[NEW:columns[NEW:column[Z:paragraph],NEW:column[O1:paragraph]]]'
		);
		row(
			[para('Q', 'q', [para('Q1')]), para('Z')],
			(ed) => ed.placeBeside(['Z'], 'Q1', 'right'),
			'Q:paragraph[NEW:columns[NEW:column[Q1:paragraph],NEW:column[Z:paragraph]]]'
		);
		// A list item in a toggle stands for its list, wrapped in the toggle.
		row(
			[
				toggle('T', {
					id: 'U',
					type: 'unordered-list',
					text: '',
					children: [{ id: 'I1', type: 'list-item', text: 'i1' }]
				}),
				para('Z')
			],
			(ed) => ed.placeBeside(['Z'], 'I1', 'right'),
			'T:toggle[NEW:columns[NEW:column[U:unordered-list[I1:list-item]],NEW:column[Z:paragraph]]]'
		);
	});

	it('inside a column, a toggle’s child cannot be wrapped (D2): a new column beside its column', () =>
		row(
			[
				cols(
					'C',
					col('K1', { id: 'T', type: 'toggle', text: 't', children: [para('T1')] }),
					col('K2', para('B'))
				),
				para('Z')
			],
			(ed) => ed.placeBeside(['Z'], 'T1', 'right'),
			'C:columns[K1:column[T:toggle[T1:paragraph]],NEW:column[Z:paragraph],K2:column[B:paragraph]]'
		));

	it('the sources are cleaned in the same plan: an emptied column goes, its layout dissolves', () => {
		row(
			SEED,
			(ed) => ed.placeBeside(['B'], 'P', 'right'),
			'NEW:columns[NEW:column[P:paragraph],NEW:column[B:paragraph]] A:paragraph A2:paragraph Z:paragraph'
		);
		row(
			SEED,
			(ed) => ed.placeBeside(['B'], 'A', 'left'),
			'P:paragraph C:columns[NEW:column[B:paragraph],K1:column[A:paragraph,A2:paragraph]] Z:paragraph'
		);
	});

	it('the result names the moved blocks', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => expect(a.ed.placeBeside(['Z', 'P'], 'B', 'right').ids).toEqual(['Z', 'P']),
				{ semantics }
			)
		))
			expect(typed(o.ed)).toMatch(/NEW:column\[Z:paragraph,P:paragraph\]/);
	});

	it('refusals: the target or an ancestor, a column, a layout or a block holding one, no layout kind', () => {
		const seed = [
			...SEED,
			cols('C2', col('L1', para('X')), col('L2', para('Y'))),
			para('T', 't', [cols('C3', col('M1', para('V')), col('M2', para('W')))]),
			{ id: 'Q', type: 'code', text: '', children: [{ id: 'QL', type: 'codeLine', text: 'q' }] }
		];
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					const no = (ids, target, side = 'right', kind?) =>
						expect(a.ed.placeBeside(ids, target, side, kind).status, `${ids} ${target}`).toBe(
							'refused'
						);
					no(['A'], 'A');
					no(['C'], 'A');
					no(['K1'], 'A');
					no(['K1'], 'Z');
					no(['C2'], 'P');
					no(['C2'], 'A');
					no(['T'], 'P');
					no(['QL'], 'P');
					no([], 'P');
					no(['Z'], 'P', 'up');
					no(['Z'], 'P', 'right', 'paragraph');
					no(['Z'], 'gone');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toMatch(/^P:paragraph C:columns/);
		// A document without a layout kind: wrapping is refused.
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => expect(a.ed.placeBeside(['Z'], 'P', 'right').status).toBe('refused'),
				{ semantics: plain }
			)
		))
			expect(typed(o.ed)).toBe(BEFORE);
	});

	it('Ada and Bob place beside the same block at once → one wrap holds it, the other dissolves', () => {
		const seed = [para('P'), para('Q'), para('Z')];
		const shapes = new Set<string>();
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					expect(a.ed.placeBeside(['Z'], 'P', 'right').status).toBe('applied');
					expect(b.ed.placeBeside(['Q'], 'P', 'right').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			shapes.add(typed(o.ed));
			expect(allText(o.ed).split('').sort().join('')).toBe('pqz');
		}
		for (const s of shapes)
			expect([
				'NEW:columns[NEW:column[P:paragraph],NEW:column[Z:paragraph]] Q:paragraph',
				'Q:paragraph NEW:columns[NEW:column[P:paragraph],NEW:column[Z:paragraph]]',
				'NEW:columns[NEW:column[P:paragraph],NEW:column[Q:paragraph]] Z:paragraph',
				'Z:paragraph NEW:columns[NEW:column[P:paragraph],NEW:column[Q:paragraph]]'
			]).toContain(s);
	});

	it('Ada places beside, Bob writes in the new column, Ada undoes → Bob’s block stays, alone (P12)', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.placeBeside(['Z'], 'P', 'right').status).toBe('applied');
					b.receiveAll(a.log);
					const column = b.ed.parentOf('Z');
					expect(b.ed.insertText('Z', 1, '!').status).toBe('applied');
					const q = [{ id: 'Q', type: 'paragraph', content: content('q') }];
					expect(b.ed.insertBlocks({ parent: column, index: 1 }, q).status).toBe('applied');
					a.receiveAll(b.log);
					expect(a.undo()).toBeTruthy();
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe(`Q:paragraph ${BEFORE}`);
			expect(shape(o.ed)).toBe('Q:"q" P:"p" C:""[K1:""[A:"a",A2:"a2"],K2:""[B:"b"]] Z:"z!"');
		}
	});
});
