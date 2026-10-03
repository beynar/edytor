/**
 * Re-score 7 (`docs/reviews/2026-09-30-rescore-7.md`), CRDT units AW-04 and
 * AW-05. Every `converge` row runs under the plan §8 multi-replica rule
 * (three client-id assignments — 240 for the two-peer races, `SWEEP` —
 * both delivery orders, duplicate delivery,
 * binary reload) and every replica is held to `wellFormed` after every
 * write and delivery. Expected trees are hand-authored from Notion's
 * behaviour: a list shows only its items, and no block's text ever
 * vanishes.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { allText, clientPairs, converge, tree } from './p1-harness.js';

/**
 * The two-peer races run on 240 client-id assignments, not only the three
 * fixed pairs (CW-01): the text order held there by luck of the ids.
 */
const SWEEP = clientPairs(240);

/**
 * Lists, code as an island of lines, columns of columns (as rescore6-crdt).
 * Columns, C0 (`docs/columns-plan.md`): `columns` is a layout (`layout.*` in the delete contract).
 */
const semantics = {
	roles: {
		code: { island: true, lines: true },
		table: { island: true },
		divider: { void: true },
		image: { void: true },
		columns: { layout: true }
	},
	rendersContent: {
		code: false,
		table: false,
		row: false,
		divider: false,
		'unordered-list': false,
		'ordered-list': false,
		columns: false,
		column: false
	},
	defaultChild: {
		code: 'codeLine',
		table: 'row',
		row: 'cell',
		'unordered-list': 'list-item',
		'ordered-list': 'list-item',
		columns: 'column'
	}
};

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

/** Every outcome converged and well-formed. */
const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

const item = (id: string, text = id, children = []) => ({ id, type: 'list-item', text, children });
const para = (id: string, text = id, children = []) => ({ id, text, children });
const list = (id: string, ...items) => ({ id, type: 'unordered-list', text: '', children: items });

/** No paragraph shows directly in a list: a list shows only its items. */
const itemsOnly = (ed) => expect(typed(ed)).not.toMatch(/-list\[[^\]]*:paragraph/);

/**
 * AW-04: Shift+Tab on a middle item moves the items before it into a new
 * list; a peer's concurrent lift or outdent of one of those items (its
 * move to the root, its retype to a paragraph) raced that move, and on
 * some client-id assignments the paragraph landed in the new list. A block
 * stored as the document's default kind now shows as its list's item
 * wherever it sits directly in a list — the read-time side of `fitted` —
 * so every replica shows an item, whatever the race.
 */
describe('AW-04: a concurrent outdent never leaves a paragraph showing directly in a list', () => {
	const three = [para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b'), item('I3', 'c'))];
	/**
	 * Where the race lands I1: in Ada's new list as its item, or out at the
	 * root as a paragraph (Ada's new list then empty: it shows nothing).
	 */
	const lifted = [
		'P:paragraph NEW:unordered-list[I1:list-item] I2:paragraph U:unordered-list[I3:list-item]',
		'P:paragraph I1:paragraph NEW:unordered-list I2:paragraph U:unordered-list[I3:list-item]',
		'P:paragraph NEW:unordered-list I1:paragraph I2:paragraph U:unordered-list[I3:list-item]'
	];

	it('Ada outdents I2 ‖ Bob lifts I1 (Backspace at its start) → I1 shows an item or a paragraph at the root', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					expect(b.ed.mergeBackward('I1').status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		)) {
			expect(allText(o.ed)).toBe('pabc');
			itemsOnly(o.ed);
			expect(lifted).toContain(typed(o.ed));
		}
	});

	it('Ada outdents I2 ‖ Bob outdents I1 → the same two shapes', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					expect(b.ed.unNestBlock('I1').status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		)) {
			expect(allText(o.ed)).toBe('pabc');
			itemsOnly(o.ed);
			expect(lifted).toContain(typed(o.ed));
		}
	});

	it('four items: Ada outdents I3 ‖ Bob outdents I2 → I2 an item of the new list, or a paragraph between', () => {
		const four = [
			para('P', 'p'),
			list('U', item('I1', 'a'), item('I2', 'b'), item('I3', 'c'), item('I4', 'd'))
		];
		for (const o of one(
			converge(
				four,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I3').status).toBe('applied');
					expect(b.ed.unNestBlock('I2').status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		)) {
			expect(allText(o.ed)).toBe('pabcd');
			itemsOnly(o.ed);
			expect(typed(o.ed)).toMatch(
				/I3:paragraph (NEW:unordered-list )?U:unordered-list\[I4:list-item\]$/
			);
		}
	});

	it('Ada outdents I2 ‖ Bob deletes the list U (keeping its items) → no paragraph in a list', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					expect(b.ed.deleteBlocks(['U']).status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		)) {
			expect(allText(o.ed)).toBe('pabc');
			itemsOnly(o.ed);
		}
	});

	it('Ada outdents I2 ‖ Bob deletes the list U with its items → no paragraph in a list', () => {
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					expect(b.ed.deleteBlock('U', { keepChildren: false }).status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		))
			itemsOnly(o.ed);
	});

	it('an explicit paragraph in a list shows as its item', () => {
		for (const o of one(
			converge(
				three,
				1,
				([a]) => expect(a.ed.setBlockType('I1', 'paragraph').status).toBe('applied'),
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(
				'P:paragraph U:unordered-list[I1:list-item,I2:list-item,I3:list-item]'
			);
	});

	it('a paragraph retyped to a list shows its paragraph children as items, and back (the change report follows)', () => {
		for (const o of one(
			converge(
				[para('Q', 'q', [para('X', 'x'), para('Y', 'y')])],
				2,
				([a, b]) => {
					expect(a.ed.setBlockType('Q', 'unordered-list').status).toBe('applied');
					expect(typed(a.ed)).toBe('Q:unordered-list[X:list-item,Y:list-item]');
					b.receiveAll(a.log);
					expect(b.ed.setBlockType('Q', 'paragraph').status).toBe('applied');
					expect(typed(b.ed)).toBe('Q:paragraph[X:paragraph,Y:paragraph]');
					a.receiveAll(b.log);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('Q:paragraph[X:paragraph,Y:paragraph]');
	});

	it('a paragraph under an item (not directly in the list) stays a paragraph', () => {
		for (const o of one(
			converge([list('U', item('I1', 'a', [para('C', 'child')]))], 1, () => {}, { semantics })
		))
			expect(typed(o.ed)).toBe('U:unordered-list[I1:list-item[C:paragraph]]');
	});
});

/**
 * AW-05: an island's lines shed into a slot took that slot's default child
 * even when it renders no content — deleting a column and then a code
 * block in the columns layout left its line as a `column`, its text
 * invisible and not editable, while the concurrent run showed a paragraph.
 * A shed line takes its slot's default child only when that kind renders
 * content, otherwise the document's default kind (as `typeOf` shows it,
 * ZW-06).
 *
 * Changed by the columns plan (`layout.dissolving`, `layout.only-items`,
 * `layout.single`): deleting the column `K2` puts its code block right after
 * the layout, which, left with one column, dissolves — so the line is shed
 * at the root, as a paragraph (its text still shows). A code block retyped
 * to a layout holds no column: its line leaves it and stays in the column,
 * and the empty layout shows nothing. A table stored directly in a layout
 * shows after it, and its rows, shed at the root, show as paragraphs.
 */
describe('AW-05: an island’s lines shed into a columns layout keep their text visible', () => {
	const seed = [
		{
			id: 'C',
			type: 'columns',
			text: '',
			children: [
				{ id: 'K1', type: 'column', text: '', children: [para('A', 'a')] },
				{
					id: 'K2',
					type: 'column',
					text: '',
					children: [
						{
							id: 'X',
							type: 'code',
							text: '',
							children: [{ id: 'Xl', type: 'codeLine', text: 'let x', children: [] }]
						}
					]
				}
			]
		}
	];
	const after = 'A:paragraph Xl:paragraph';

	it('deleting the code block X (keeping its lines) → its line shows a paragraph', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.deleteBlocks(['K2']).status).toBe('applied');
					expect(a.ed.deleteBlocks(['X']).status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe(after);
			expect(tree(o.ed)).toBe('A:"a" Xl:"let x"');
		}
	});

	it('setBlockType(X, divider) → its line shows a paragraph', () => {
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.deleteBlocks(['K2']).status).toBe('applied');
					expect(a.ed.setBlockType('X', 'divider').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toMatch(/Xl:paragraph/);
	});

	it('setBlockType(X, columns) → X keeps its line, as a paragraph (a column would hide it)', () => {
		for (const o of one(
			converge(seed, 1, ([a]) => expect(a.ed.setBlockType('X', 'columns').status).toBe('applied'), {
				semantics
			})
		))
			expect(typed(o.ed)).toBe('C:columns[K1:column[A:paragraph],K2:column[Xl:paragraph]]');
	});

	it('sequential and concurrent runs agree: Ada deletes X ‖ Bob types in its line', () => {
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['K2']).status).toBe('applied');
					expect(a.ed.deleteBlocks(['X']).status).toBe('applied');
					expect(b.ed.insertText('Xl', 5, ';').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(typed(o.ed)).toBe(after);
			expect(tree(o.ed)).toBe('A:"a" Xl:"let x;"');
		}
	});

	it('Ada deletes X ‖ Bob adds a line to it → the written and the read-time line show alike', () => {
		for (const o of one(
			converge(
				seed,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['K2']).status).toBe('applied');
					b.receiveAll(a.log);
					expect(a.ed.deleteBlocks(['X']).status).toBe('applied');
					b.ed.insertBlocks({ parent: 'X', index: 1 }, [
						{ id: 'Xl2', type: 'codeLine', content: [{ kind: 'text', text: 'let y' }] }
					]);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('A:paragraph Xl:paragraph Xl2:paragraph');
	});

	/**
	 * A child that renders no content of its own (a table's row) loses no
	 * text as a column: it takes the slot's default child, as `typeOf` shows
	 * a row a peer adds meanwhile.
	 */
	it('Ada deletes a table T in the layout ‖ Bob adds a row → both rows show alike', () => {
		const table = [
			{
				id: 'C',
				type: 'columns',
				text: '',
				children: [
					{ id: 'K1', type: 'column', text: '', children: [para('A', 'a')] },
					{
						id: 'T',
						type: 'table',
						text: '',
						children: [
							{
								id: 'R',
								type: 'row',
								text: '',
								children: [{ id: 'c1', type: 'cell', text: 'x', children: [] }]
							}
						]
					}
				]
			}
		];
		for (const o of one(
			converge(
				table,
				2,
				([a, b]) => {
					expect(a.ed.deleteBlocks(['T']).status).toBe('applied');
					b.ed.insertBlocks({ parent: 'T', index: 1 }, [
						{
							id: 'R2',
							type: 'row',
							children: [{ id: 'c2', type: 'cell', content: [{ kind: 'text', text: 'y' }] }]
						}
					]);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('A:paragraph R:paragraph[c1:cell] R2:paragraph[c2:cell]');
	});
});

/**
 * DR-crdt-1 (review of AW-04): the view's Turn into (`convertToKind`: the
 * lift and the retype in one plan) races an outdent the way a lift does —
 * the split's move of the item into the new list races the Turn into's
 * lift of it. A kind other than the document's default keeps its kind and
 * data wherever the race leaves it (as a merge that sheds it into a list
 * does, DR-crdt-1): the documented residual — it may stay in the new list.
 * Every replica agrees, the text keeps its order, and no paragraph shows.
 */
describe('DR-crdt-1: Turn into ‖ an outdent — a kind keeps its kind wherever the race leaves it', () => {
	const three = [para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b'), item('I3', 'c'))];
	const turnInto = (ed, id: string, type: string, data = {}) =>
		ed.apply(ed.compose(ed.prepare.liftOut(id, type), ed.prepare.setBlock(id, { type, data })));
	/** Bob's lift wins (I1 at the root, Ada's new list empty) or Ada's move does (I1 in it). */
	const shapes = (kind: string) => [
		`P:paragraph NEW:unordered-list[I1:${kind}] I2:paragraph U:unordered-list[I3:list-item]`,
		`P:paragraph I1:${kind} NEW:unordered-list I2:paragraph U:unordered-list[I3:list-item]`,
		`P:paragraph NEW:unordered-list I1:${kind} I2:paragraph U:unordered-list[I3:list-item]`
	];

	for (const [kind, data] of [
		['heading', { level: 1 }],
		['todo', { checked: true }]
	] as const)
		it(`Ada outdents I2 ‖ Bob turns I1 into a ${kind} → I1 a ${kind} with its data, in the new list or at the root`, () => {
			const seen = new Set<string>();
			for (const o of one(
				converge(
					three,
					2,
					([a, b]) => {
						expect(a.ed.unNestBlock('I2').status).toBe('applied');
						expect(turnInto(b.ed, 'I1', kind, data).status).toBe('applied');
						expect(typed(b.ed)).toBe(
							`P:paragraph I1:${kind} U:unordered-list[I2:list-item,I3:list-item]`
						);
					},
					{ semantics, assignments: SWEEP }
				)
			)) {
				expect(allText(o.ed)).toBe('pabc');
				itemsOnly(o.ed);
				expect(o.ed.blockDataOf('I1')).toEqual(data);
				expect(shapes(kind)).toContain(typed(o.ed));
				seen.add(typed(o.ed));
			}
			// Not vacuous: the residual is reached (the new list keeps I1 on some assignment).
			expect(seen).toContain(shapes(kind)[0]);
		});

	it('four items: Ada outdents I3 ‖ Bob turns I2 into a heading → the text keeps its order, I2 a heading', () => {
		const four = [
			para('P', 'p'),
			list('U', item('I1', 'a'), item('I2', 'b'), item('I3', 'c'), item('I4', 'd'))
		];
		// Both split U: I1 stays an item; I2 a heading in Ada's new list or at the root; the
		// list a split leaves empty shows nothing (the next key next to it removes it).
		const shapes = [
			'P:paragraph NEW:unordered-list NEW:unordered-list[I1:list-item,I2:heading] I3:paragraph U:unordered-list[I4:list-item]',
			'P:paragraph NEW:unordered-list[I1:list-item] I2:heading NEW:unordered-list I3:paragraph U:unordered-list[I4:list-item]',
			'P:paragraph NEW:unordered-list NEW:unordered-list[I1:list-item] I2:heading I3:paragraph U:unordered-list[I4:list-item]'
		];
		for (const o of one(
			converge(
				four,
				2,
				([a, b]) => {
					expect(a.ed.unNestBlock('I3').status).toBe('applied');
					expect(turnInto(b.ed, 'I2', 'heading', { level: 2 }).status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		)) {
			expect(allText(o.ed)).toBe('pabcd');
			itemsOnly(o.ed);
			expect(shapes).toContain(typed(o.ed));
		}
	});
});

/**
 * DR-crdt-2 (review of AW-05): an island retyped to an ordinary kind
 * retyped every child to the new kind's default child, but a child a peer
 * adds meanwhile shows its stored kind (`typeOf` re-kinds only line kinds
 * outside their island) — a table retyped to a columns layout while a peer
 * adds a row showed a `column` and a `row` side by side. Only an island's
 * lines are retyped (no line kind outside its island); any other child
 * keeps its kind, sequentially and concurrently.
 *
 * Changed by the columns plan (`layout.only-items`, `layout.single`): a
 * layout displays only its columns, so the rows, which keep their kind,
 * show right after it, and the layout, holding no column, shows nothing.
 */
describe('DR-crdt-2: an island retyped to an ordinary kind — sequential and concurrent children agree', () => {
	const table = [
		{
			id: 'T',
			type: 'table',
			text: '',
			children: [
				{
					id: 'R',
					type: 'row',
					text: '',
					children: [{ id: 'c1', type: 'cell', text: 'x', children: [] }]
				}
			]
		}
	];
	const row2 = {
		id: 'R2',
		type: 'row',
		children: [{ id: 'c2', type: 'cell', content: [{ kind: 'text', text: 'y' }] }]
	};

	it('setBlockType(table, columns) ‖ Bob adds a row → both rows keep their kind', () => {
		for (const o of one(
			converge(
				table,
				2,
				([a, b]) => {
					expect(a.ed.setBlockType('T', 'columns').status).toBe('applied');
					expect(b.ed.insertBlocks({ parent: 'T', index: 1 }, [row2]).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('R:row[c1:cell] R2:row[c2:cell]');
	});

	it('Bob’s row delivered first: the sequential retype gives the same tree', () => {
		for (const o of one(
			converge(
				table,
				2,
				([a, b]) => {
					expect(b.ed.insertBlocks({ parent: 'T', index: 1 }, [row2]).status).toBe('applied');
					a.receiveAll(b.log);
					expect(a.ed.setBlockType('T', 'columns').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('R:row[c1:cell] R2:row[c2:cell]');
	});

	it('setBlock({type: columns}) agrees with setBlockType: the rows stay rows', () => {
		for (const o of one(
			converge(
				table,
				1,
				([a]) => expect(a.ed.setBlock('T', { type: 'columns', data: {} }).status).toBe('applied'),
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('R:row[c1:cell]');
	});

	it('a code block retyped to a paragraph still turns its lines into paragraphs, a peer’s too', () => {
		const code = [
			{
				id: 'X',
				type: 'code',
				text: '',
				children: [{ id: 'Xl', type: 'codeLine', text: 'let x', children: [] }]
			}
		];
		for (const o of one(
			converge(
				code,
				2,
				([a, b]) => {
					expect(a.ed.setBlockType('X', 'paragraph').status).toBe('applied');
					b.ed.insertBlocks({ parent: 'X', index: 1 }, [
						{ id: 'Xl2', type: 'codeLine', content: [{ kind: 'text', text: 'let y' }] }
					]);
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe('X:paragraph[Xl:paragraph,Xl2:paragraph]');
	});
});

/**
 * DR-crdt-3 (sweep): a block stored as a paragraph that shows as its
 * list's item (`itemOf`, AW-04 — a race, a concurrent undo, an explicit
 * write) left the list as a bullet. The move pins the kind the block shows
 * (a move keeps its kind), and the outdent's own retype to a paragraph was
 * dropped as a same-value write: the block was stored as a paragraph
 * already. Leaving a list gives a paragraph, as for any item: Shift+Tab,
 * Backspace at the first item, Turn into Text, deleting the list.
 */
describe('DR-crdt-3: an item stored as a paragraph leaves its list as a paragraph', () => {
	const seed = [
		para('P0', 'p'),
		list(
			'U',
			{ id: 'I1', type: 'paragraph', text: 'a', children: [] },
			{ id: 'I2', type: 'paragraph', text: 'b', children: [] },
			item('I3', 'c')
		)
	];
	const turnInto = (ed, id: string, type: string) =>
		ed.apply(ed.compose(ed.prepare.liftOut(id, type), ed.prepare.setBlock(id, { type })));
	const rows: [string, (ed) => unknown, string][] = [
		[
			'Shift+Tab on the middle one (unNestBlock)',
			(ed) => ed.unNestBlock('I2'),
			'P0:paragraph NEW:unordered-list[I1:list-item] I2:paragraph U:unordered-list[I3:list-item]'
		],
		[
			'Shift+Tab on both (unNestBlocks)',
			(ed) => ed.unNestBlocks(['I1', 'I2']),
			'P0:paragraph I1:paragraph I2:paragraph U:unordered-list[I3:list-item]'
		],
		[
			'Backspace at the first one (mergeBackward lifts it)',
			(ed) => ed.mergeBackward('I1'),
			'P0:paragraph I1:paragraph U:unordered-list[I2:list-item,I3:list-item]'
		],
		[
			'Turn into Text (liftOut + setBlock)',
			(ed) => turnInto(ed, 'I2', 'paragraph'),
			'P0:paragraph NEW:unordered-list[I1:list-item] I2:paragraph U:unordered-list[I3:list-item]'
		],
		[
			'deleting the list, keeping its items',
			(ed) => ed.deleteBlock('U', { keepChildren: true }),
			'P0:paragraph I1:paragraph I2:paragraph I3:paragraph'
		]
	];
	for (const [name, op, want] of rows)
		it(name, () => {
			for (const o of one(
				converge(seed, 1, ([a]) => expect(op(a.ed).status).toBe('applied'), { semantics })
			))
				expect(typed(o.ed)).toBe(want);
		});

	it('one undo of the outdent puts it back as the item it showed, redo outdents it again', () => {
		const before = 'P0:paragraph U:unordered-list[I1:list-item,I2:list-item,I3:list-item]';
		const after = rows[0][2];
		for (const o of one(
			converge(
				seed,
				1,
				([a]) => {
					expect(a.ed.unNestBlock('I2').status).toBe('applied');
					expect(typed(a.ed)).toBe(after);
					a.undo();
					expect(typed(a.ed)).toBe(before);
					a.redo();
				},
				{ semantics }
			)
		))
			expect(typed(o.ed)).toBe(after);
	});

	it('after the AW-04 race, Shift+Tab on the item the race left in the new list gives a paragraph', () => {
		const three = [para('P', 'p'), list('U', item('I1', 'a'), item('I2', 'b'), item('I3', 'c'))];
		let reached = false;
		for (const o of one(
			converge(
				three,
				2,
				([a, b]) => {
					a.ed.unNestBlock('I2');
					b.ed.mergeBackward('I1');
					a.receiveAll(b.log);
					b.receiveAll(a.log);
					const parent = a.ed.positionOf('I1')?.parent;
					if (parent == null) return;
					reached = true;
					expect(a.ed.unNestBlock('I1').status).toBe('applied');
				},
				{ semantics, assignments: SWEEP }
			)
		))
			expect([
				'P:paragraph I1:paragraph I2:paragraph U:unordered-list[I3:list-item]',
				'P:paragraph I1:paragraph NEW:unordered-list I2:paragraph U:unordered-list[I3:list-item]',
				'P:paragraph NEW:unordered-list I1:paragraph I2:paragraph U:unordered-list[I3:list-item]'
			]).toContain(typed(o.ed));
		expect(reached, 'the race left I1 in the new list on some assignment').toBe(true);
	});
});
