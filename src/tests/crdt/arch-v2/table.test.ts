/**
 * Tables (`table.*` in `docs/editor-delete-contract.md`), at the document
 * layer. A table is a kind whose role says `table: true`; its default child
 * is its row kind, whose default child is its cell kind (a text island);
 * the table lists its columns in `data.columns` and each cell names its
 * column. Every `converge` row runs under the plan §8 multi-replica rule
 * (three client-id assignments, both delivery orders, duplicate delivery,
 * binary reload: display equality across every replica, observer and
 * reload) and every replica is held to `wellFormed` (`table-shape`
 * included) after every write and delivery. Expected grids are written
 * from the contract rows.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { converge } from './p1-harness.js';
import * as crdt from '../../../lib/crdt/index.js';
import { createDocument, tableBlock } from '../../../lib/crdt/index.js';
import { defaultSemantics, semanticsOf, tableKinds } from '../../../lib/crdt/semantics.js';

const semantics = defaultSemantics;

const para = (id: string, text = id.toLowerCase(), children = []) => ({ id, text, children });
const cell = (id: string, column?: string, text = id.toLowerCase()) => ({
	id,
	type: 'tableCell',
	text,
	...(column !== undefined && { data: { column } })
});
const trow = (id: string, ...cells) => ({ id, type: 'tableRow', text: '', children: cells });
const table = (id: string, columns: string[] | null, ...rows) => ({
	id,
	type: 'table',
	text: '',
	...(columns !== null && { data: { columns: columns.map((c) => ({ id: c })) } }),
	children: rows
});

/** `P, T:table{c1, c2}[R1[A:c1, B:c2], R2[C:c1, D:c2]], Z` — the contract's `T`. */
const SEED = [
	para('P'),
	table(
		'T',
		['c1', 'c2'],
		trow('R1', cell('A', 'c1'), cell('B', 'c2')),
		trow('R2', cell('C', 'c1'), cell('D', 'c2'))
	),
	para('Z')
];

/** A minted id shown as `NEW`. */
const named = (s: string) => s.replace(/\b[bc]_[A-Za-z0-9_-]+/g, 'NEW');

/**
 * The visible tree: `id"text"[children]`, a table as `T{columns}[rows]`
 * and each row's cells as its grid shows them (`_` for a padded cell).
 */
const show = (ed) => {
	const visit = (b) => {
		if (ed.isTable(b.id)) {
			const grid = ed.tableGrid(b.id);
			const rows = grid.rows.map(
				(r) =>
					`${r.id}[${r.cells.map((c) => (c === null ? '_' : `${c}"${ed.blockText(c)}"`)).join(',')}]`
			);
			return `${b.id}{${grid.columns.join(',')}}[${rows.join(',')}]`;
		}
		const kids = b.children?.length ? `[${b.children.map(visit).join(',')}]` : '';
		const text = (b.content ?? []).map((c) => c.text ?? `⟨${c.type}⟩`).join('');
		return `${b.id}"${text}"${kids}`;
	};
	return named(ed.toJSON().children.map(visit).join(' '));
};

/** Every outcome converged and well-formed. */
const one = (outcomes) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
	}
	return outcomes;
};

const BEFORE = 'P"p" T{c1,c2}[R1[A"a",B"b"],R2[C"c",D"d"]] Z"z"';

/** A single-replica row: `op` applies, undo restores, redo brings it back; the result shows `out`. */
const row = (seed, op: (ed) => { status: string }, out: string) => {
	for (const o of one(
		converge(
			seed,
			1,
			([a]) => {
				const before = show(a.ed);
				expect(op(a.ed).status).toBe('applied');
				const after = show(a.ed);
				a.undo();
				expect(show(a.ed)).toBe(before);
				a.redo();
				expect(show(a.ed)).toBe(after);
			},
			{ semantics }
		)
	))
		expect(show(o.ed)).toBe(out);
};

/** A read-only row: the seed displays as `out` on every replica. */
const shows = (seed, out: string) => {
	for (const o of one(converge(seed, 1, () => {}, { semantics }))) expect(show(o.ed)).toBe(out);
};

describe('table semantics: the role is data', () => {
	it('tableKinds are the bundled rows, and defaultSemantics holds them', () => {
		expect(tableKinds).toEqual({
			table: { table: true, rendersContent: false, defaultChild: 'tableRow' },
			tableRow: { rendersContent: false, defaultChild: 'tableCell' },
			tableCell: { island: true }
		});
		expect(crdt.tableSemantics).toEqual(semanticsOf(tableKinds));
		expect(defaultSemantics.roles.table).toEqual({ table: true });
		expect(defaultSemantics.roles.tableCell).toEqual({ island: true });
		expect(defaultSemantics.defaultChild.table).toBe('tableRow');
		expect(defaultSemantics.defaultChild.tableRow).toBe('tableCell');
	});

	it('the role is read from the semantics, not the names', () => {
		const grid = semanticsOf({
			sheet: { table: true, rendersContent: false, defaultChild: 'line' },
			line: { rendersContent: false, defaultChild: 'slot' },
			slot: { island: true }
		});
		const doc = createDocument({
			semantics: grid,
			value: {
				children: [
					{
						type: 'sheet',
						id: 'S',
						data: { columns: [{ id: 'x' }] },
						children: [
							{
								type: 'line',
								id: 'L',
								children: [{ type: 'slot', id: 'X', data: { column: 'x' } }]
							}
						]
					}
				]
			}
		});
		expect(doc.facade.isTable('S')).toBe(true);
		expect(doc.facade.isTableRow('L')).toBe(true);
		expect(doc.facade.isTableCell('X')).toBe(true);
		expect(doc.facade.tableOf('X')).toBe('S');
		doc.destroy();
	});

	it('tableBlock builds a seeded table: columns c1…, each cell naming its column', () => {
		const block = tableBlock({ cells: [['a', 'b'], ['c']], headerRow: true, widths: [120] });
		expect(block).toEqual({
			type: 'table',
			data: { columns: [{ id: 'c1', width: 120 }, { id: 'c2' }], headerRow: true },
			children: [
				{
					type: 'tableRow',
					data: {},
					children: [
						{ type: 'tableCell', data: { column: 'c1' }, content: [{ text: 'a' }] },
						{ type: 'tableCell', data: { column: 'c2' }, content: [{ text: 'b' }] }
					]
				},
				{
					type: 'tableRow',
					data: {},
					children: [
						{ type: 'tableCell', data: { column: 'c1' }, content: [{ text: 'c' }] },
						{ type: 'tableCell', data: { column: 'c2' } }
					]
				}
			]
		});
		// One value, one seed: the same table twice.
		const one = createDocument({ value: { children: [tableBlock({ rows: 2, columns: 3 })] } });
		const two = createDocument({ value: { children: [tableBlock({ rows: 2, columns: 3 })] } });
		expect(JSON.stringify(one.facade.toJSON())).toBe(JSON.stringify(two.facade.toJSON()));
		one.destroy();
		two.destroy();
	});
});

describe('table display (read)', () => {
	it('table.columns: every row shows its cells in the table’s column order', () => {
		shows(
			[table('T', ['c2', 'c1'], trow('R1', cell('A', 'c1'), cell('B', 'c2')))],
			'T{c2,c1}[R1[B"b",A"a"]]'
		);
	});

	it('table.columns: a table listing no columns shows its cells in their order', () => {
		shows(
			[table('T', null, trow('R1', cell('A'), cell('B')), trow('R2', cell('C')))],
			'T{0,1}[R1[A"a",B"b"],R2[C"c",_]]'
		);
	});

	it('table.cell: a cell of no listed column, or a second one for a column, does not display', () => {
		for (const o of one(
			converge(
				[
					table(
						'T',
						['c1', 'c2'],
						trow('R1', cell('A', 'c1'), cell('X', 'gone'), cell('Y', 'c1'), cell('B', 'c2'))
					)
				],
				1,
				() => {},
				{ semantics }
			)
		)) {
			expect(show(o.ed)).toBe('T{c1,c2}[R1[A"a",B"b"]]');
			expect(o.ed.childrenIds('R1')).toEqual(['A', 'B']);
			expect(o.ed.runsView.dissolved('X')).toBe(true);
			expect(o.ed.runsView.dissolved('Y')).toBe(true);
			expect(o.ed.isVisibleBlock('X')).toBe(false);
		}
	});

	it('table.row: an empty row and a table showing no row do not display', () => {
		shows(
			[
				para('P'),
				table('T', ['c1'], trow('R1'), trow('R2', cell('A', 'c1'))),
				table('U', ['c1'], trow('R3', cell('X', 'gone'))),
				para('Z')
			],
			'P"p" T{c1}[R2[A"a"]] Z"z"'
		);
	});

	it('table.row / table.cell: no row outside a table, no cell outside a row', () => {
		shows(
			[
				para('P'),
				trow('R0', cell('X')),
				cell('Y'),
				table('T', ['c1'], trow('R1', cell('A', 'c1'))),
				para('Z')
			],
			'P"p" T{c1}[R1[A"a"]] Z"z"'
		);
	});

	it('table.only-rows: another child of a table or a row shows right after the table', () => {
		shows(
			[table('T', ['c1'], trow('R1', cell('A', 'c1'), para('Q')), para('S')), para('Z')],
			'T{c1}[R1[A"a"]] Q"q" S"s" Z"z"'
		);
	});

	it('the seed shows the contract’s T', () => shows(SEED, BEFORE));
});

describe('table.fits: a table holds rows, a row cells', () => {
	it('a cell never moves; a row moves only within its table', () => {
		for (const o of one(
			converge(
				[...SEED, table('U', ['x'], trow('R3', cell('E', 'x')))],
				1,
				([a]) => {
					expect(a.ed.canPlace(['A'])).toBe(false);
					expect(a.ed.canPlace(['A'], 'R2')).toBe(false);
					expect(a.ed.canPlace(['R1'], null)).toBe(false);
					expect(a.ed.canPlace(['R1'], 'U')).toBe(false);
					expect(a.ed.canPlace(['P'], 'T')).toBe(false);
					expect(a.ed.canPlace(['P'], 'R1')).toBe(false);
					expect(a.ed.canPlace(['P'], 'A')).toBe(false);
					expect(a.ed.moveBlocks(['R1'], { parent: null, index: 0 }).status).toBe('refused');
					expect(a.ed.moveBlocks(['A'], { parent: 'R2', index: 0 }).status).toBe('refused');
					expect(a.ed.nestBlock('P', 'T').status).toBe('refused');
					expect(a.ed.moveBlocks(['R2'], { parent: 'T', index: 0 }).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe('P"p" T{c1,c2}[R2[C"c",D"d"],R1[A"a",B"b"]] Z"z" U{x}[R3[E"e"]]');
	});

	it('table.merge: nothing merges into or out of a cell, and a cell never splits', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => {
					expect(a.ed.canMerge('B', 'A')).toBe(false);
					expect(a.ed.canMerge('A', 'P')).toBe(false);
					expect(a.ed.canMerge('Z', 'D')).toBe(false);
					expect(a.ed.mergeBackward('B').status).toBe('refused');
					expect(a.ed.mergeBackward('A').status).toBe('refused');
					expect(a.ed.mergeBackward('Z').status).toBe('refused');
					expect(a.ed.mergeForward('D').status).toBe('refused');
					expect(a.ed.splitBlock('A', 1, 'b_new').status).toBe('refused');
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe(BEFORE);
	});
});

describe('table ops (write)', () => {
	it('table.insert-row', () =>
		row(
			SEED,
			(ed) => ed.insertTableRow('T', 1),
			'P"p" T{c1,c2}[R1[A"a",B"b"],NEW[NEW"",NEW""],R2[C"c",D"d"]] Z"z"'
		));

	it('table.delete-row: the rows go with their cells, the last one with the table', () => {
		row(SEED, (ed) => ed.deleteTableRows(['R1']), 'P"p" T{c1,c2}[R2[C"c",D"d"]] Z"z"');
		row(SEED, (ed) => ed.deleteTableRows(['R1', 'R2']), 'P"p" Z"z"');
		for (const o of one(
			converge(SEED, 1, ([a]) => expect(a.ed.deleteTableRows(['A']).status).toBe('refused'), {
				semantics
			})
		))
			expect(show(o.ed)).toBe(BEFORE);
	});

	it('a block delete of a table or a row takes its rows and cells', () => {
		row(SEED, (ed) => ed.deleteBlocks(['T']), 'P"p" Z"z"');
		row(SEED, (ed) => ed.deleteBlocks(['R1']), 'P"p" T{c1,c2}[R2[C"c",D"d"]] Z"z"');
		row(SEED, (ed) => ed.deleteBlock('T'), 'P"p" Z"z"');
	});

	it('table.insert-column', () =>
		row(
			SEED,
			(ed) => ed.insertTableColumn('T', 1),
			'P"p" T{c1,NEW,c2}[R1[A"a",NEW"",B"b"],R2[C"c",NEW"",D"d"]] Z"z"'
		));

	it('table.insert-column with a width', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => expect(a.ed.insertTableColumn('T', 2, 180).status).toBe('applied'),
				{
					semantics
				}
			)
		))
			expect(o.ed.tableColumns('T').at(-1).width).toBe(180);
	});

	it('table.delete-column: by id or position; the last column takes the table', () => {
		row(SEED, (ed) => ed.deleteTableColumn('T', 'c2'), 'P"p" T{c1}[R1[A"a"],R2[C"c"]] Z"z"');
		row(SEED, (ed) => ed.deleteTableColumn('T', 0), 'P"p" T{c2}[R1[B"b"],R2[D"d"]] Z"z"');
		const single = [para('P'), table('T', ['c1'], trow('R1', cell('A', 'c1'))), para('Z')];
		row(single, (ed) => ed.deleteTableColumn('T', 'c1'), 'P"p" Z"z"');
	});

	it('table.move-column: one order patch, no cell moves', () =>
		row(
			SEED,
			(ed) => ed.moveTableColumn('T', 'c1', 1),
			'P"p" T{c2,c1}[R1[B"b",A"a"],R2[D"d",C"c"]] Z"z"'
		));

	it('table.move-row', () =>
		row(
			SEED,
			(ed) => ed.moveTableRows(['R2'], 0),
			'P"p" T{c1,c2}[R2[C"c",D"d"],R1[A"a",B"b"]] Z"z"'
		));

	it('table.header and table.width are data patches', () => {
		for (const o of one(
			converge(
				SEED,
				1,
				([a]) => {
					expect(a.ed.patchData('T', [{ path: ['headerRow'], value: true }]).status).toBe(
						'applied'
					);
					expect(
						a.ed.patchData('T', [{ path: ['columns', '1', 'width'], value: 240 }]).status
					).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(o.ed.blockDataOf('T').headerRow).toBe(true);
			expect(o.ed.tableColumns('T')).toEqual([{ id: 'c1' }, { id: 'c2', width: 240 }]);
			expect(show(o.ed)).toBe(BEFORE);
		}
	});

	it('table.pad: fillTableCell creates the missing cell, refused where one shows', () => {
		const padded = [
			para('P'),
			table(
				'T',
				['c1', 'c2'],
				trow('R1', cell('A', 'c1'), cell('B', 'c2')),
				trow('R2', cell('D', 'c2'))
			),
			para('Z')
		];
		shows(padded, 'P"p" T{c1,c2}[R1[A"a",B"b"],R2[_,D"d"]] Z"z"');
		row(
			padded,
			(ed) => ed.fillTableCell('R2', 'c1'),
			'P"p" T{c1,c2}[R1[A"a",B"b"],R2[NEW"",D"d"]] Z"z"'
		);
		for (const o of one(
			converge(SEED, 1, ([a]) => expect(a.ed.fillTableCell('R1', 'c1').status).toBe('refused'), {
				semantics
			})
		))
			expect(show(o.ed)).toBe(BEFORE);
	});

	it('a column op on a table listing no columns lists them first, in its plan', () => {
		const loose = [table('T', null, trow('R1', cell('A'), cell('B')), trow('R2', cell('C')))];
		row(
			loose,
			(ed) => ed.insertTableColumn('T', 0),
			'T{NEW,c1,c2}[R1[NEW"",A"a",B"b"],R2[NEW"",C"c",_]]'
		);
		row(loose, (ed) => ed.fillTableCell('R2', 1), 'T{c1,c2}[R1[A"a",B"b"],R2[C"c",NEW""]]');
	});
});

describe('table.range: a range keeps the cells it crosses', () => {
	const TEXTS = [
		para('P', 'para'),
		table(
			'T',
			['c1', 'c2'],
			trow('R1', cell('A', 'c1', 'alpha'), cell('B', 'c2', 'beta')),
			trow('R2', cell('C', 'c1', 'gamma'), cell('D', 'c2', 'delta'))
		),
		para('Z', 'zed')
	];
	const range = (from, to, out, at) =>
		row(
			TEXTS,
			(ed) => {
				const p = ed.prepare.deleteRange(from, to);
				expect(p.at).toEqual(at);
				return ed.apply(p);
			},
			out
		);

	it('within one row: each cell loses what the range covers', () =>
		range(
			{ block: 'A', offset: 2 },
			{ block: 'B', offset: 2 },
			'P"para" T{c1,c2}[R1[A"al",B"ta"],R2[C"gamma",D"delta"]] Z"zed"',
			{ block: 'A', offset: 2 }
		));

	it('across rows: the cells between are emptied, none removed', () =>
		range(
			{ block: 'A', offset: 0 },
			{ block: 'D', offset: 3 },
			'P"para" T{c1,c2}[R1[A"",B""],R2[C"",D"ta"]] Z"zed"',
			{ block: 'A', offset: 0 }
		));

	it('from a line before the table into a cell: nothing merges into the cell', () =>
		range(
			{ block: 'P', offset: 2 },
			{ block: 'B', offset: 2 },
			'P"pa" T{c1,c2}[R1[A"",B"ta"],R2[C"gamma",D"delta"]] Z"zed"',
			{ block: 'P', offset: 2 }
		));

	it('from a cell to a line after the table: the line keeps its suffix', () =>
		range(
			{ block: 'C', offset: 1 },
			{ block: 'Z', offset: 1 },
			'P"para" T{c1,c2}[R1[A"alpha",B"beta"],R2[C"g",D""]] Z"ed"',
			{ block: 'C', offset: 1 }
		));

	it('from a line before into a table under a header: the header loses its covered text', () =>
		row(
			[
				para('P', 'para'),
				para('G', 'header', [
					table(
						'T',
						['c1', 'c2'],
						trow('R1', cell('A', 'c1', 'alpha'), cell('B', 'c2', 'beta')),
						trow('R2', cell('C', 'c1', 'gamma'), cell('D', 'c2', 'delta'))
					)
				]),
				para('Z', 'zed')
			],
			(ed) => {
				const p = ed.prepare.deleteRange({ block: 'P', offset: 0 }, { block: 'A', offset: 2 });
				expect(p.at).toEqual({ block: 'P', offset: 0 });
				return ed.apply(p);
			},
			'P"" G""[T{c1,c2}[R1[A"pha",B"beta"],R2[C"gamma",D"delta"]]] Z"zed"'
		));

	it('from a cell to a line nested after the table: its parent loses its covered text', () =>
		row(
			[...TEXTS.slice(0, 2), para('G', 'header', [para('K', 'kid')]), para('Z', 'zed')],
			(ed) => {
				const p = ed.prepare.deleteRange({ block: 'D', offset: 1 }, { block: 'K', offset: 1 });
				expect(p.at).toEqual({ block: 'D', offset: 1 });
				return ed.apply(p);
			},
			'P"para" T{c1,c2}[R1[A"alpha",B"beta"],R2[C"gamma",D"d"]] G""[K"id"] Z"zed"'
		));

	it('a table wholly between the ends goes whole', () =>
		range({ block: 'P', offset: 1 }, { block: 'Z', offset: 1 }, 'P"ped"', {
			block: 'P',
			offset: 1
		}));
});

describe('table.paste: a flow into a cell joins its text', () => {
	const lines = (...texts) => ({
		lines: texts.map((t, i) =>
			typeof t === 'string'
				? { id: `b_l${i}`, type: 'paragraph', content: [{ kind: 'text', text: t }] }
				: t
		)
	});
	it('several lines join the cell’s text with line breaks', () =>
		row(
			SEED,
			(ed) => ed.insertFlow({ block: 'B', offset: 1 }, lines('x', 'y')),
			'P"p" T{c1,c2}[R1[A"a",B"bx\ny"],R2[C"c",D"d"]] Z"z"'
		));

	it('a whole flow (blocks) joins too; a pasted table gives its cells’ text', () =>
		row(
			SEED,
			(ed) =>
				ed.insertFlow(
					{ block: 'A', offset: 1 },
					{
						whole: true,
						lines: [
							{
								id: 'b_t',
								type: 'table',
								data: { columns: [{ id: 'k' }] },
								children: [
									{
										id: 'b_r',
										type: 'tableRow',
										children: [
											{
												id: 'b_c',
												type: 'tableCell',
												data: { column: 'k' },
												content: [{ kind: 'text', text: 'q' }]
											}
										]
									}
								]
							},
							{ id: 'b_p', type: 'paragraph', content: [{ kind: 'text', text: 'w' }] }
						]
					}
				),
			'P"p" T{c1,c2}[R1[A"aq\nw",B"b"],R2[C"c",D"d"]] Z"z"'
		));

	it('a cell outside a row is its text, a row outside a table its cells', () =>
		row(
			SEED,
			(ed) =>
				ed.insertFlow(
					{ block: 'Z', offset: 1 },
					{
						lines: [
							{
								id: 'b_c1',
								type: 'tableCell',
								data: { column: 'k' },
								content: [{ kind: 'text', text: 'x' }]
							},
							{
								id: 'b_r',
								type: 'tableRow',
								children: [
									{
										id: 'b_c2',
										type: 'tableCell',
										data: { column: 'k' },
										content: [{ kind: 'text', text: 'y' }]
									}
								]
							}
						]
					}
				),
			'P"p" T{c1,c2}[R1[A"a",B"b"],R2[C"c",D"d"]] Z"zx" NEW"y"'
		));

	it('a table pasted outside a table lands as a table', () =>
		row(
			SEED,
			(ed) =>
				ed.insertFlow(
					{ block: 'Z', offset: 1 },
					{
						lines: [
							{
								id: 'b_t',
								type: 'table',
								data: { columns: [{ id: 'k' }] },
								children: [
									{
										id: 'b_r',
										type: 'tableRow',
										children: [
											{
												id: 'b_c',
												type: 'tableCell',
												data: { column: 'k' },
												content: [{ kind: 'text', text: 'q' }]
											}
										]
									}
								]
							}
						]
					}
				),
			'P"p" T{c1,c2}[R1[A"a",B"b"],R2[C"c",D"d"]] Z"z" NEW{k}[NEW[NEW"q"]]'
		));
});

describe('table concurrency', () => {
	it('table.conc.row-insert: a row insert racing a column delete', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.insertTableRow('T', 2).status).toBe('applied');
					expect(b.ed.deleteTableColumn('T', 'c2').status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe('P"p" T{c1}[R1[A"a"],R2[C"c"],NEW[NEW""]] Z"z"');
	});

	it('table.conc.column-insert: a column insert racing a row insert pads the new row', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.insertTableColumn('T', 2).status).toBe('applied');
					expect(b.ed.insertTableRow('T', 2).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe(
				'P"p" T{c1,c2,NEW}[R1[A"a",B"b",NEW""],R2[C"c",D"d",NEW""],NEW[NEW"",NEW"",_]] Z"z"'
			);
	});

	it('table.conc.row-delete: a cell edit racing a row delete goes with the row', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.insertText('A', 1, '!').status).toBe('applied');
					expect(b.ed.deleteTableRows(['R1']).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe('P"p" T{c1,c2}[R2[C"c",D"d"]] Z"z"');
	});

	it('table.conc.row-delete: a column insert racing a row delete adds no cell outside a row', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.insertTableColumn('T', 2).status).toBe('applied');
					expect(b.ed.deleteTableRows(['R1']).status).toBe('applied');
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe('P"p" T{c1,c2,NEW}[R2[C"c",D"d",NEW""]] Z"z"');
	});

	it('table.conc.column-move: a column move racing a row insert orders the new row too', () => {
		for (const o of one(
			converge(
				SEED,
				2,
				([a, b]) => {
					expect(a.ed.moveTableColumn('T', 'c1', 1).status).toBe('applied');
					expect(b.ed.insertTableRow('T', 0).status).toBe('applied');
					expect(b.ed.insertText(b.ed.tableGrid('T').rows[0].cells[0], 0, 'x').status).toBe(
						'applied'
					);
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe('P"p" T{c2,c1}[NEW[NEW"",NEW"x"],R1[B"b",A"a"],R2[D"d",C"c"]] Z"z"');
	});

	it('table.conc.fill-twice: one cell per row and column displays (the residual)', () => {
		const padded = [table('T', ['c1', 'c2'], trow('R1', cell('A', 'c1')))];
		for (const o of one(
			converge(
				padded,
				2,
				([a, b]) => {
					expect(a.ed.fillTableCell('R1', 'c2').status).toBe('applied');
					expect(b.ed.fillTableCell('R1', 'c2').status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			const grid = o.ed.tableGrid('T');
			expect(grid.rows[0].cells.every((c) => c !== null)).toBe(true);
			expect(o.ed.childrenIds('R1')).toHaveLength(2);
		}
	});

	/** Ada inserts a column after `c1`, Bob types in its `R1` cell, Ada undoes (`deliver`: synced first). */
	const columnUndo = (synced: boolean, after?: (a, b) => void) =>
		one(
			converge(
				SEED,
				2,
				([a, b]) => {
					b.receiveAll(
						a.capture(() => expect(a.ed.insertTableColumn('T', 1).status).toBe('applied'))
					);
					const cell = b.ed.tableGrid('T').rows[0].cells[1];
					const typed = b.capture(() =>
						expect(b.ed.insertText(cell, 0, 'BOB').status).toBe('applied')
					);
					if (synced) a.receiveAll(typed);
					b.receiveAll(a.capture(() => a.undo()));
					if (!synced) a.receiveAll(typed);
					after?.(a, b);
				},
				{ semantics }
			)
		);

	it('table.conc.column-undo: undoing a column insert keeps a peer’s text, its column shown last', () => {
		for (const synced of [true, false])
			for (const o of columnUndo(synced))
				expect(show(o.ed)).toBe('P"p" T{c1,c2,NEW}[R1[A"a",B"b",NEW"BOB"],R2[C"c",D"d",_]] Z"z"');
	});

	it('table.conc.column-undo: the redo lists the column again where it was', () => {
		for (const o of columnUndo(true, (a, b) => b.receiveAll(a.capture(() => a.redo()))))
			expect(show(o.ed)).toBe('P"p" T{c1,NEW,c2}[R1[A"a",NEW"BOB",B"b"],R2[C"c",NEW"",D"d"]] Z"z"');
	});

	it('table.conc.column-undo: the column goes once the peer’s text does', () => {
		for (const o of columnUndo(true, (a, b) => {
			const cell = b.ed.tableGrid('T').rows[0].cells[2];
			a.receiveAll(b.capture(() => b.ed.deleteText(cell, 0, 3)));
		}))
			expect(show(o.ed)).toBe(BEFORE);
	});

	it('table.conc.column-undo: filling the shown column lists it; deleting it deletes its cells', () => {
		for (const o of columnUndo(true, (a, b) => {
			const column = b.ed.tableGrid('T').columns[2];
			expect(b.ed.tableColumns('T').map((c) => c.id)).toEqual(['c1', 'c2']);
			expect(b.ed.moveTableColumn('T', column, 0).status).toBe('refused');
			a.receiveAll(b.capture(() => b.ed.fillTableCell('R2', column)));
			expect(b.ed.tableColumns('T').map((c) => c.id)).toEqual(['c1', 'c2', column]);
		}))
			expect(show(o.ed)).toBe('P"p" T{c1,c2,NEW}[R1[A"a",B"b",NEW"BOB"],R2[C"c",D"d",NEW""]] Z"z"');
		for (const o of columnUndo(true, (a, b) =>
			a.receiveAll(b.capture(() => expect(b.ed.deleteTableColumn('T', 2).status).toBe('applied')))
		))
			expect(show(o.ed)).toBe(BEFORE);
	});

	it('table.conc.adopt: column ops racing on a table listing no columns list the same ones', () => {
		const unlisted = [
			table('T', null, trow('R1', cell('A'), cell('B')), trow('R2', cell('C'), cell('D')))
		];
		for (const o of one(
			converge(
				unlisted,
				2,
				([a, b]) => {
					expect(a.ed.insertTableColumn('T', 2).status).toBe('applied');
					expect(b.ed.insertTableColumn('T', 2).status).toBe('applied');
				},
				{ semantics }
			)
		)) {
			expect(show(o.ed)).toBe(
				'T{c1,c2,NEW,NEW}[R1[A"a",B"b",NEW"",NEW""],R2[C"c",D"d",NEW"",NEW""]]'
			);
		}
		for (const o of one(
			converge(
				unlisted,
				2,
				([a, b]) => {
					expect(a.ed.insertTableRow('T', 2).status).toBe('applied');
					expect(b.ed.deleteTableColumn('T', 1).status).toBe('applied');
				},
				{ semantics }
			)
		))
			// The residual: the delete of `c2` loses to the adoption writing it again; its cells go.
			expect(show(o.ed)).toBe('T{c1,c2}[R1[A"a",_],R2[C"c",_],NEW[NEW"",NEW""]]');
	});

	it('two column deletes and a header toggle converge', () => {
		for (const o of one(
			converge(
				SEED,
				3,
				([a, b, c]) => {
					expect(a.ed.deleteTableColumn('T', 'c1').status).toBe('applied');
					expect(b.ed.deleteTableColumn('T', 'c2').status).toBe('applied');
					expect(c.ed.patchData('T', [{ path: ['headerRow'], value: true }]).status).toBe(
						'applied'
					);
				},
				{ semantics }
			)
		))
			expect(show(o.ed)).toBe('P"p" Z"z"');
	});
});

describe('table-shape: the well-formed check names a wrong display', () => {
	it('flags rows and cells shown out of shape', async () => {
		const { wellFormedProblems } = await import('../harness/assert/well-formed.js');
		const tables = new Map([['table', { row: 'tableRow', cell: 'tableCell' }]]);
		const c = (id, column) => ({ id, type: 'tableCell', data: { column } });
		const r = (id, ...cells) => ({ id, type: 'tableRow', children: cells });
		const t = (id, rows) => ({
			id,
			type: 'table',
			data: { columns: [{ id: 'x' }, { id: 'y' }] },
			children: rows
		});
		const check = (roots) =>
			wellFormedProblems({ roots, tables }).filter((p) => p.startsWith('table-shape'));
		expect(check([t('T', [r('R', c('A', 'x'), c('B', 'y'))])])).toEqual([]);
		expect(check([t('T', [])])).toEqual(['table-shape: table T shows no row']);
		expect(check([t('T', [r('R', c('B', 'y'), c('A', 'x'))])])).toEqual([
			'table-shape: row R shows its cells out of column order or twice'
		]);
		expect(check([t('T', [r('R', c('A', 'z'))])])).toEqual([
			'table-shape: row R shows a cell of no listed column'
		]);
		expect(check([r('R', c('A', 'x'))])).toEqual([
			'table-shape: row R shows outside a table',
			'table-shape: cell A shows outside a table’s row'
		]);
		expect(check([t('T', [r('R')])])).toEqual(['table-shape: row R shows no cell']);
		// A withdrawn cell of a column no longer listed shows after the listed ones.
		const withdrawn = (id) => id === 'W';
		const checkW = (roots) =>
			wellFormedProblems({ roots, tables, withdrawn }).filter((p) => p.startsWith('table-shape'));
		expect(checkW([t('T', [r('R', c('A', 'x'), c('B', 'y'), c('W', 'z'))])])).toEqual([]);
		expect(checkW([t('T', [r('R', c('W', 'z'), c('A', 'x'))])])).toEqual([
			'table-shape: row R shows its cells out of column order or twice'
		]);
		expect(checkW([t('T', [r('R', c('A', 'x'), c('V', 'z'))])])).toEqual([
			'table-shape: row R shows a cell of no listed column'
		]);
	});
});
