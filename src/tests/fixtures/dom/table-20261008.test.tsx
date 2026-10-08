/** @jsxImportSource ../../jsx */
/**
 * The table plugin in a mounted editor (`table.*` in the delete contract,
 * Notion's simple table): the grid it renders (roles, header cells, widths,
 * a padded cell), the keys in a cell (`table.keys`, `table.merge`: Enter a
 * line break, Backspace at a cell's start stays, Tab and Shift+Tab walk the
 * cells, Tab in the last one adds a row, the arrows go up and down a
 * column), a padded cell's press, the block menu's header switches, the
 * chrome's menus and `+`, the slash command, and the clipboard (HTML
 * import and export of `table`/`tr`/`td`/`th`). Expected states are
 * written from the contract rows and Notion.
 *
 * `P "p", T{c1, c2}[R1[A "a", B "b"], R2[C "c", D "d"]], Z "z"`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { tablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import {
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (id: string, text = id.toLowerCase()): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text }]
});
const cell = (id: string, column: string, text = id.toLowerCase()): JSONBlock => ({
	id,
	type: 'tableCell',
	data: { column },
	content: text ? [{ text }] : []
});
const row = (id: string, ...cells: JSONBlock[]): JSONBlock => ({
	id,
	type: 'tableRow',
	children: cells
});
const table = (
	id: string,
	columns: (string | { id: string; width?: number })[],
	rows: JSONBlock[],
	data: Record<string, boolean> = {}
): JSONBlock => ({
	id,
	type: 'table',
	data: { columns: columns.map((c) => (typeof c === 'string' ? { id: c } : c)), ...data },
	children: rows
});
const contract = (): JSONBlock[] => [
	p('P'),
	table(
		'T',
		['c1', 'c2'],
		[row('R1', cell('A', 'c1'), cell('B', 'c2')), row('R2', cell('C', 'c1'), cell('D', 'c2'))]
	),
	p('Z')
];

const render = (children: JSONBlock[] = contract(), plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [...plugins, tablePlugin, richTextPlugin],
			value: { children },
			autoSelectFixture: false
		}
	);

/** `table`'s grid: each row's cells' texts, `_` for a padded cell. */
const grid = (edytor: Edytor, id = 'T') =>
	edytor.facade
		.tableGrid(id)
		?.rows.map((r) => r.cells.map((c) => (c === null ? '_' : edytor.facade.blockText(c))));

const caretIn = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
	await flushDomUpdates();
};
const caret = (edytor: Edytor) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return { block: startBlock?.id, offset: yStart, isCollapsed };
};
const node = (editor: HTMLElement, id: string) =>
	editor.querySelector<HTMLElement>(`[data-edytor-id="${id}"]`)!;

describe('the table renders as a grid', () => {
	it('a table, its rows and cells with their roles; the columns’ widths', async () => {
		const { editor } = await render([
			table('T', [{ id: 'c1', width: 200 }, 'c2'], [row('R1', cell('A', 'c1'), cell('B', 'c2'))])
		]);
		const t = node(editor, 'T');
		expect(t.getAttribute('role')).toBe('table');
		expect(node(editor, 'R1').getAttribute('role')).toBe('row');
		expect(node(editor, 'A').getAttribute('role')).toBe('cell');
		expect(node(editor, 'A').dataset.edytorColumn).toBe('0');
		expect(node(editor, 'B').dataset.edytorColumn).toBe('1');
		const gridNode = t.querySelector<HTMLElement>('[data-edytor-table-grid]')!;
		expect(gridNode.style.gridTemplateColumns).toBe('200px 120px');
	});

	it('a header row’s cells are column headers, a header column’s row headers', async () => {
		const { editor } = await render([
			table(
				'T',
				['c1', 'c2'],
				[row('R1', cell('A', 'c1'), cell('B', 'c2')), row('R2', cell('C', 'c1'), cell('D', 'c2'))],
				{ headerRow: true, headerColumn: true }
			)
		]);
		expect(node(editor, 'A').getAttribute('role')).toBe('columnheader');
		expect(node(editor, 'B').getAttribute('role')).toBe('columnheader');
		expect(node(editor, 'C').getAttribute('role')).toBe('rowheader');
		expect(node(editor, 'D').getAttribute('role')).toBe('cell');
		expect(node(editor, 'D').dataset.edytorTableHeader).toBeUndefined();
	});

	it('table.pad: a row showing no cell of a column has a placeholder there; its press fills it', async () => {
		const { edytor, editor } = await render([
			table(
				'T',
				['c1', 'c2'],
				[row('R1', cell('A', 'c1'), cell('B', 'c2')), row('R2', cell('D', 'c2'))]
			)
		]);
		const pad = node(editor, 'R2').querySelector<HTMLElement>('[data-edytor-table-pad]')!;
		expect(pad.dataset.edytorColumn).toBe('0');
		expect(pad.style.gridColumn).toBe('1');
		expect(pad.getAttribute('contenteditable')).toBe('false');
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['_', 'd']
		]);
		pad.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['', 'd']
		]);
		const filled = edytor.facade.tableGrid('T')!.rows[1]!.cells[0]!;
		expect(caret(edytor)).toEqual({ block: filled, offset: 0, isCollapsed: true });
		expect(node(editor, 'R2').querySelector('[data-edytor-table-pad]')).toBeNull();
	});
});

describe('keys in a cell (table.keys, table.merge)', () => {
	it('Enter is a line break in the cell; no row or cell is added', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A', 1);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(grid(edytor)).toEqual([
			['a\n', 'b'],
			['c', 'd']
		]);
		expect(caret(edytor)).toEqual({ block: 'A', offset: 2, isCollapsed: true });
	});

	it('Backspace at a cell’s start writes nothing and keeps the caret', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'B', 0);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
		expect(caret(edytor)).toEqual({ block: 'B', offset: 0, isCollapsed: true });
		await caretIn(edytor, 'A', 0);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(edytor.facade.blockText('P')).toBe('p');
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
		expect(caret(edytor)).toEqual({ block: 'A', offset: 0, isCollapsed: true });
	});

	it('Backspace at the start of the block after a table goes to the last cell’s end', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'Z', 0);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
		expect(edytor.facade.blockText('Z')).toBe('z');
		expect(caret(edytor)).toEqual({ block: 'D', offset: 1, isCollapsed: true });
	});

	it('Tab and Shift+Tab walk the cells in reading order', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'A', 0);
		const tab = await dispatchDomKeyDown(editor, { key: 'Tab' });
		expect(tab.defaultPrevented).toBe(true);
		expect(caret(edytor)).toEqual({ block: 'B', offset: 1, isCollapsed: true });
		await dispatchDomKeyDown(editor, { key: 'Tab' });
		expect(caret(edytor)).toEqual({ block: 'C', offset: 1, isCollapsed: true });
		await dispatchDomKeyDown(editor, { key: 'Tab', shiftKey: true });
		expect(caret(edytor)).toEqual({ block: 'B', offset: 1, isCollapsed: true });
		await caretIn(edytor, 'A', 0);
		await dispatchDomKeyDown(editor, { key: 'Tab', shiftKey: true });
		expect(caret(edytor)).toEqual({ block: 'A', offset: 0, isCollapsed: true });
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('Tab in the last cell adds a row and goes to its first cell; one undo removes it', async () => {
		const { edytor, editor } = await render();
		await caretIn(edytor, 'D', 1);
		await dispatchDomKeyDown(editor, { key: 'Tab' });
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd'],
			['', '']
		]);
		const first = edytor.facade.tableGrid('T')!.rows[2]!.cells[0]!;
		expect(caret(edytor)).toEqual({ block: first, offset: 0, isCollapsed: true });
		edytor.historyUndo();
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('ArrowDown and ArrowUp go to the cell below and above in the column', async () => {
		const { edytor, editor } = await render([
			table(
				'T',
				['c1', 'c2'],
				[
					row('R1', cell('A', 'c1', 'alpha'), cell('B', 'c2')),
					row('R2', cell('C', 'c1', 'gamma'), cell('D', 'c2'))
				]
			),
			p('Z')
		]);
		await caretIn(edytor, 'A', 2);
		const down = await dispatchDomKeyDown(editor, { key: 'ArrowDown' });
		expect(down.defaultPrevented).toBe(true);
		expect(caret(edytor)).toEqual({ block: 'C', offset: 2, isCollapsed: true });
		await dispatchDomKeyDown(editor, { key: 'ArrowUp' });
		expect(caret(edytor)).toEqual({ block: 'A', offset: 2, isCollapsed: true });
		// Out of the table, the browser moves (nothing claimed).
		const up = await dispatchDomKeyDown(editor, { key: 'ArrowUp' });
		expect(up.defaultPrevented).toBe(false);
	});

	it('Tab never nests and a cell is never a slash menu target', async () => {
		const { edytor, editor } = await render(contract(), [slashMenuPlugin]);
		await caretIn(edytor, 'A', 1);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '/' });
		expect(document.querySelector('[data-edytor-slash-menu]')).toBeNull();
		expect(grid(edytor)).toEqual([
			['a/', 'b'],
			['c', 'd']
		]);
	});
});

describe('a block selection never holds a row or a cell', () => {
	it('selecting a cell or a row selects its table; Backspace then deletes the table', async () => {
		const { edytor, editor } = await render();
		edytor.selection.selectBlocks(edytor.idToBlock.get('B')!, edytor.idToBlock.get('R2')!);
		await flushDomUpdates();
		expect([...edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['T']);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(edytor.facade.childrenIds(null)).toEqual(['P', 'Z']);
	});
});

describe('the block menu’s header switches', () => {
	it('Header row and Header column toggle the table’s flags, one undo step each', async () => {
		const { edytor } = await render(contract(), [createBlockMenuPlugin()]);
		const t = edytor.idToBlock.get('T')!;
		const rows = t.definition.menu!(t);
		expect(rows.map((r) => [r.id, r.checked])).toEqual([
			['table.header-row', false],
			['table.header-column', false]
		]);
		rows[0]!.run();
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('T')!.headerRow).toBe(true);
		expect(t.definition.menu!(t)[0]!.checked).toBe(true);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(edytor.facade.blockDataOf('T')!.headerRow).toBeUndefined();
	});
});

describe('the chrome: menus and `+`', () => {
	const hover = async (edytor: Edytor, editor: HTMLElement, id: string) => {
		node(editor, id).dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		edytor.overlay.invalidate();
		await flushDomUpdates();
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		await flushDomUpdates();
	};
	const layer = () => document.querySelector<HTMLElement>('[data-edytor-table-chrome][role]')!;

	it('a row’s grip opens its menu: insert below, then delete that row', async () => {
		const { edytor, editor } = await render();
		await hover(edytor, editor, 'C');
		const grip = layer().querySelector<HTMLButtonElement>('[data-edytor-table-grip="row"]')!;
		expect(grip).not.toBeNull();
		grip.click();
		await flushDomUpdates();
		const items = [...layer().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		expect(items.map((b) => b.dataset.testid)).toEqual([
			'table-menu-insert-above',
			'table-menu-insert-below',
			'table-menu-move-up',
			'table-menu-move-down',
			'table-menu-delete-row'
		]);
		expect(items[3]!.disabled).toBe(true);
		items[1]!.click();
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd'],
			['', '']
		]);
		await hover(edytor, editor, 'A');
		layer().querySelector<HTMLButtonElement>('[data-edytor-table-grip="row"]')!.click();
		await flushDomUpdates();
		layer().querySelector<HTMLButtonElement>('[data-testid="table-menu-delete-row"]')!.click();
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['c', 'd'],
			['', '']
		]);
	});

	it('a row’s grip: move down, then up again', async () => {
		const { edytor, editor } = await render();
		const pick = async (row: string, id: string) => {
			await hover(edytor, editor, row);
			layer().querySelector<HTMLButtonElement>('[data-edytor-table-grip="row"]')!.click();
			await flushDomUpdates();
			layer().querySelector<HTMLButtonElement>(`[data-testid="table-menu-${id}"]`)!.click();
			await flushDomUpdates();
		};
		await pick('A', 'move-down');
		expect(grid(edytor)).toEqual([
			['c', 'd'],
			['a', 'b']
		]);
		await pick('A', 'move-up');
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('a column’s grip: insert right, move left, delete', async () => {
		const { edytor, editor } = await render();
		await hover(edytor, editor, 'B');
		const open = async () => {
			layer().querySelector<HTMLButtonElement>('[data-edytor-table-grip="column"]')!.click();
			await flushDomUpdates();
		};
		const pick = async (id: string) => {
			layer().querySelector<HTMLButtonElement>(`[data-testid="table-menu-${id}"]`)!.click();
			await flushDomUpdates();
		};
		await open();
		await pick('move-left');
		expect(grid(edytor)).toEqual([
			['b', 'a'],
			['d', 'c']
		]);
		await hover(edytor, editor, 'A');
		await open();
		await pick('insert-right');
		expect(grid(edytor)).toEqual([
			['b', 'a', ''],
			['d', 'c', '']
		]);
		await hover(edytor, editor, 'B');
		await open();
		await pick('delete-column');
		expect(grid(edytor)).toEqual([
			['a', ''],
			['c', '']
		]);
	});

	it('the `+` under the table adds a row, the one beside it a column', async () => {
		const { edytor, editor } = await render();
		await hover(edytor, editor, 'A');
		layer().querySelector<HTMLButtonElement>('[data-edytor-table-add="row"]')!.click();
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd'],
			['', '']
		]);
		layer().querySelector<HTMLButtonElement>('[data-edytor-table-add="column"]')!.click();
		await flushDomUpdates();
		expect(grid(edytor)).toEqual([
			['a', 'b', ''],
			['c', 'd', ''],
			['', '', '']
		]);
	});

	it('a readonly view shows no chrome', async () => {
		const { edytor, editor } = await render();
		edytor.readonly = true;
		await hover(edytor, editor, 'A');
		expect(layer()?.querySelector('[data-edytor-table-grip]') ?? null).toBeNull();
	});
});

describe('the clipboard: HTML import and export', () => {
	it('a pasted <table> lands as a table: columns by position, its first row a header row', async () => {
		const { edytor, editor } = await render([p('P')]);
		await caretIn(edytor, 'P', 1);
		await dispatchClipboardPaste(editor, {
			'text/html':
				'<table><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td>Ada</td><td><b>Eng</b></td></tr></tbody></table>',
			'text/plain': 'Name\tRole\nAda\tEng'
		});
		const t = edytor.facade.childrenIds(null).find((id) => edytor.facade.isTable(id))!;
		expect(t).toBeDefined();
		expect(grid(edytor, t)).toEqual([
			['Name', 'Role'],
			['Ada', 'Eng']
		]);
		expect(edytor.facade.blockDataOf(t)).toEqual({
			columns: [{ id: 'c1' }, { id: 'c2' }],
			headerRow: true
		});
		const eng = edytor.facade.tableGrid(t)!.rows[1]!.cells[1]!;
		expect(edytor.facade.blockJSON(eng).content).toEqual([{ text: 'Eng', marks: { bold: true } }]);
	});

	it('cells copied out of a table paste as lines of text, never as stray cells', async () => {
		const { edytor, editor } = await render();
		const a = edytor.idToBlock.get('A')!.firstText!;
		const b = edytor.idToBlock.get('B')!.firstText!;
		edytor.selection.setAtRange(a, 0, b, 1);
		await flushDomUpdates();
		const { clipboardData } = await dispatchCopy(editor);
		await caretIn(edytor, 'Z', 1);
		await dispatchClipboardPaste(editor, clipboardData);
		const texts = edytor.facade
			.childrenIds(null)
			.filter((id) => !edytor.facade.isTable(id))
			.map((id) => edytor.facade.blockText(id));
		expect(texts.join('|')).toBe('p|za|b');
		expect(grid(edytor)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('a copied table exports <table>/<tr>/<td>, its header row as <th>', async () => {
		const { edytor, editor } = await render([
			table(
				'T',
				['c1', 'c2'],
				[row('R1', cell('A', 'c1'), cell('B', 'c2')), row('R2', cell('C', 'c1'), cell('D', 'c2'))],
				{
					headerRow: true
				}
			)
		]);
		edytor.selection.selectBlocks(edytor.idToBlock.get('T')!);
		await flushDomUpdates();
		const { clipboardData } = await dispatchCopy(editor);
		const html = clipboardData['text/html'] ?? '';
		expect(html).toContain(
			'<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></tbody></table>'
		);
		expect(clipboardData['text/plain']).toBe('a\tb\nc\td');
	});
});

describe('the Table command', () => {
	it('turns an empty line into a 3 × 3 table, the caret in its first cell', async () => {
		const { edytor } = await render([{ id: 'E', type: 'paragraph', content: [] }]);
		await caretIn(edytor, 'E', 0);
		await edytor.commands.get('block.table')!.run(edytor);
		await flushDomUpdates();
		const t = edytor.facade.childrenIds(null).find((id) => edytor.facade.isTable(id))!;
		expect(grid(edytor, t)).toEqual([
			['', '', ''],
			['', '', ''],
			['', '', '']
		]);
		expect(caret(edytor).block).toBe(edytor.facade.tableGrid(t)!.rows[0]!.cells[0]);
	});
});
