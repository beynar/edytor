<script module lang="ts">
	import './table.css';
	import type { BlockSnippetPayload, BlockView, Plugin } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { tableKinds } from '$lib/crdt/semantics.js';
	import { tableBlock } from '$lib/crdt/tables.js';
	import { onPress } from '$lib/events/onFocus.js';
	import { keywordsOf, labelsWith, viewLabels } from '$lib/labels.js';
	import TableChromeLayer from './TableChrome.svelte';
	import { TableChrome } from './chrome.svelte.js';
	import {
		caretCell,
		fillCell,
		tabFrom,
		toggleHeader,
		verticalFrom,
		widthOf,
		type TablePluginOptions
	} from './table.js';

	export type { TablePluginOptions };

	const tablePlugins = new WeakSet<Plugin>();
	/** Each view's chrome (the first table plugin listed in it claims the view). */
	const chromes = new WeakMap<Edytor, TableChrome>();
	const labelsOf = viewLabels('table');

	/** Recognize any table plugin instance. */
	export const isTablePlugin = (plugin: Plugin) => tablePlugins.has(plugin);

	/** The ids of a row's cell, its row and its table, from the handle (stable while it shows). */
	const parentsOf = (edytor: Edytor, id: string | undefined) => {
		const cell = id ? edytor.idToBlock.get(id) : undefined;
		const row = cell?.parent;
		const table = row?.parent;
		return { cell, row, table };
	};

	/** The column ids `table`'s rows show, read from the cells (reactive): listed, else by position. */
	const columnsOfTable = (edytor: Edytor, table: string): string[] => {
		const cell = edytor.cells?.get(table);
		const listed = cell?.data?.columns;
		if (Array.isArray(listed))
			return listed.flatMap((c) => {
				const id = (c as { id?: unknown } | null)?.id;
				return typeof id === 'string' ? [id] : [];
			});
		const widest = Math.max(
			0,
			...(cell?.childIds ?? []).map((row) => edytor.cells?.get(row)?.childIds.length ?? 0)
		);
		return Array.from({ length: widest }, (_, i) => String(i));
	};

	/** A cell's column position in its table (reactive through the cells), `-1` when none. */
	const columnIndex = (edytor: Edytor, table: string, row: string, id: string): number => {
		const columns = columnsOfTable(edytor, table);
		const listed = Array.isArray(edytor.cells?.get(table)?.data?.columns);
		if (!listed) return edytor.cells?.get(row)?.childIds.indexOf(id) ?? -1;
		const column = edytor.cells?.get(id)?.data?.column;
		return typeof column === 'string' ? columns.indexOf(column) : -1;
	};

	/**
	 * Notion's simple table (`table.*` in the delete contract): a `table` of
	 * `tableRow`s of `tableCell`s, each cell a text island whose lines are line
	 * breaks (Enter is a line break in a cell). The columns are the table's
	 * `data.columns` (ids and widths), each cell names its column, and the
	 * header flags are `data.headerRow` and `data.headerColumn`. The table is a
	 * CSS grid (`table.css`): a row shows its cells in its table's column
	 * order, a padded cell (a peer's row inserted while a column was) as an
	 * empty placeholder whose first press creates it. Tab and Shift+Tab walk
	 * the cells (Tab in the last one adds a row), ArrowUp and ArrowDown go to
	 * the cell above and below. On hover, a `+` under and beside the table adds
	 * a row or a column, the grips of a row and a column open their menus
	 * (insert, move, delete), and a band on each column's edge resizes it. The
	 * block menu of a table has its Header row and Header column switches.
	 * Not a default plugin; its roles are in `defaultSemantics`.
	 */
	export const createTablePlugin = (options: TablePluginOptions = {}): Plugin => {
		const columnWidth = options.columnWidth ?? 120;
		const minColumnWidth = options.minColumnWidth ?? 48;
		const fresh = tableBlock({ rows: options.rows ?? 3, columns: options.columns ?? 3 });
		const plugin: Plugin = (edytor) => {
			const labels = labelsWith('table', options.labels);
			labelsOf.claim(edytor, labels);
			const chrome =
				chromes.get(edytor) ?? new TableChrome(edytor, labels, columnWidth, minColumnWidth);
			chromes.set(edytor, chrome);
			/** A cell's element: its role, its column, and whether a header row or column holds it. */
			const cellElement = (data: Record<string, unknown>, id?: string) => {
				const { row, table } = parentsOf(edytor, id);
				const tableId = table?.id;
				if (!id || !row?.id || !tableId)
					return { tag: 'div', attributes: { 'data-edytor-table-cell': '' } };
				const tableData = edytor.cells?.get(tableId)?.data;
				const rowIndex = edytor.cells?.get(tableId)?.childIds.indexOf(row.id) ?? -1;
				const column = columnIndex(edytor, tableId, row.id, id);
				const headerRow = tableData?.headerRow === true && rowIndex === 0;
				const headerColumn = tableData?.headerColumn === true && column === 0;
				void data;
				return {
					tag: 'div',
					attributes: {
						'data-edytor-table-cell': '',
						'data-edytor-column': String(column),
						'data-edytor-table-header': headerRow || headerColumn ? 'true' : undefined,
						role: headerRow ? 'columnheader' : headerColumn ? 'rowheader' : 'cell'
					}
				};
			};
			return {
				blocks: {
					table: {
						...tableKinds.table,
						element: (data) => ({
							tag: 'div',
							attributes: {
								'data-edytor-table': '',
								'data-edytor-table-header-row': data.headerRow === true ? 'true' : undefined,
								'data-edytor-table-header-column': data.headerColumn === true ? 'true' : undefined,
								role: 'table',
								'aria-label': labels.table
							}
						}),
						snippet: table,
						empty: { content: [], children: fresh.children },
						presets: [
							{
								label: labels.table,
								data: fresh.data,
								keywords: keywordsOf(
									'block.table',
									['table', 'grid', 'simple table', 'rows', 'columns'],
									options.keywords
								),
								group: 'Advanced blocks'
							}
						],
						menu: (block) => [
							{
								id: 'table.header-row',
								label: labels.headerRow,
								icon: 'table.header-row',
								checked: block.data.headerRow === true,
								run: () => toggleHeader(block, 'headerRow')
							},
							{
								id: 'table.header-column',
								label: labels.headerColumn,
								icon: 'table.header-column',
								checked: block.data.headerColumn === true,
								run: () => toggleHeader(block, 'headerColumn')
							}
						],
						html: (block, _, children) => tableHtml(block.data ?? {}, children),
						plain: (_, __, children) => children,
						parse: (element) => (element.localName === 'table' ? parseTable(element) : undefined)
					},
					tableRow: {
						...tableKinds.tableRow,
						element: { tag: 'div', attributes: { 'data-edytor-table-row': '', role: 'row' } },
						snippet: row,
						html: (_, __, children) => `<tr>${children}</tr>`,
						plain: (_, __, children) => children.split('\n').join('\t'),
						parse: (element) => (element.localName === 'tr' ? {} : undefined)
					},
					tableCell: {
						...tableKinds.tableCell,
						element: cellElement,
						snippet: cell,
						html: (_, content) => `<td>${content}</td>`,
						plain: (_, content) => content.replace(/\n/g, ' '),
						parse: (element) => (/^t[dh]$/.test(element.localName) ? parseCell(element) : undefined)
					}
				},
				hotkeys: {
					tab: ({ prevent }) => {
						const cell = caretCell(edytor);
						if (cell && !edytor.selection.selectedBlocks.size) prevent(() => tabFrom(cell, 1));
					},
					'shift+tab': ({ prevent }) => {
						const cell = caretCell(edytor);
						if (cell && !edytor.selection.selectedBlocks.size) prevent(() => tabFrom(cell, -1));
					},
					arrowup: ({ prevent }) => {
						const cell = caretCell(edytor);
						if (cell && verticalFrom(cell, -1)) prevent();
					},
					arrowdown: ({ prevent }) => {
						const cell = caretCell(edytor);
						if (cell && verticalFrom(cell, 1)) prevent();
					}
				},
				onEdytorAttached: ({ node }) => {
					if (chromes.get(edytor) !== chrome) return;
					const over = (event: PointerEvent) => chrome.hover(event.target);
					const leave = (event: PointerEvent) => chrome.leave(event.relatedTarget);
					const layer = edytor.overlay.layer;
					const document = node.ownerDocument;
					const drag = (event: Event) => (chrome.dragging = event.type === 'dragstart');
					node.addEventListener('pointerover', over);
					node.addEventListener('pointerleave', leave);
					layer?.addEventListener('pointerleave', leave);
					document.addEventListener('dragstart', drag, true);
					document.addEventListener('dragend', drag, true);
					document.addEventListener('drop', drag, true);
					// A press outside an open grip menu closes it.
					const outside = onPress(
						edytor,
						document,
						(event) => {
							const target = event.target as Node | null;
							if (!chrome.menu || (target && layer?.contains(target))) return;
							chrome.menu = null;
							edytor.overlay.invalidate();
						},
						true
					);
					const unmount = edytor.overlay.mount(
						TableChromeLayer,
						{ chrome },
						'edytor-table-chrome',
						6,
						chrome.measure
					);
					return () => {
						node.removeEventListener('pointerover', over);
						node.removeEventListener('pointerleave', leave);
						layer?.removeEventListener('pointerleave', leave);
						document.removeEventListener('dragstart', drag, true);
						document.removeEventListener('dragend', drag, true);
						document.removeEventListener('drop', drag, true);
						outside();
						unmount();
					};
				}
			};
		};
		tablePlugins.add(plugin);
		return plugin;
	};

	/** The table with the default options. */
	export const tablePlugin = createTablePlugin();

	/** `table`'s grid template: each column's width (the resize preview while a band drags it). */
	const templateOf = (view: BlockView) => {
		const edytor = view.handle?.edytor;
		const chrome = edytor && chromes.get(edytor);
		const listed = view.data.columns;
		const fallback = chrome?.columnWidth ?? 120;
		if (Array.isArray(listed))
			return listed
				.map(
					(column, i) =>
						`${chrome ? chrome.width(view.id, i, column) : widthOf(column, fallback)}px`
				)
				.join(' ');
		const count = edytor ? columnsOfTable(edytor, view.id).length : 0;
		return Array.from({ length: Math.max(1, count) }, () => `${fallback}px`).join(' ');
	};

	/** The columns a row shows no cell of (`table.pad`), by position, from the cells (reactive). */
	const padsOf = (view: BlockView): number[] => {
		const edytor = view.handle?.edytor;
		const table = view.handle?.parent?.id;
		if (!edytor || !table) return [];
		const columns = columnsOfTable(edytor, table);
		const shown = new Set(
			(edytor.cells?.get(view.id)?.childIds ?? []).map((cell) =>
				columnIndex(edytor, table, view.id, cell)
			)
		);
		return columns.flatMap((_, i) => (shown.has(i) ? [] : [i]));
	};

	/** A padded cell's press: its cell is created, the caret in it (`table.pad`). */
	const fillPad = (view: BlockView, column: number, event: MouseEvent) => {
		const edytor = view.handle?.edytor;
		const table = view.handle?.parent;
		if (!edytor || !table?.id || edytor.readonly || event.button !== 0) return;
		event.preventDefault();
		const columns = edytor.facade.tableColumns(table.id);
		fillCell(table, view.id, columns ? columns[column]!.id : column);
	};

	/** The table's HTML (`<table>`): its header row's and header column's cells are `th`. */
	const tableHtml = (data: Record<string, unknown>, rows: string) => {
		let html = rows;
		if (data.headerColumn === true)
			html = html.replace(/<tr><td>([\s\S]*?)<\/td>/g, '<tr><th>$1</th>');
		if (data.headerRow === true)
			html = html.replace(
				/^<tr>([\s\S]*?)<\/tr>/,
				(_, row: string) => `<tr>${row.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')}</tr>`
			);
		return `<table><tbody>${html}</tbody></table>`;
	};

	/** The rows of an imported `<table>` (its own, not a nested table's). */
	const rowsOf = (table: HTMLElement): HTMLTableRowElement[] =>
		[...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);

	/** An imported `<table>`'s data: a column per cell of its widest row, its header flags. */
	const parseTable = (table: HTMLElement) => {
		const rows = rowsOf(table);
		const width = Math.max(1, ...rows.map((tr) => tr.cells.length));
		const head = (cell: Element | undefined) => cell?.localName === 'th';
		const headerRow = rows.length > 1 && [...(rows[0]?.cells ?? [])].every((c) => head(c));
		const headerColumn =
			rows.length > 0 && rows.slice(headerRow ? 1 : 0).every((tr) => head(tr.cells[0]));
		return {
			columns: Array.from({ length: width }, (_, i) => ({ id: `c${i + 1}` })),
			...(headerRow && { headerRow: true }),
			...(headerColumn && !headerRow && { headerColumn: true })
		};
	};

	/** An imported cell's column: its position in its row (`c1`, `c2`, … as its table's). */
	const parseCell = (cell: HTMLElement) => {
		const index = (cell as HTMLTableCellElement).cellIndex;
		return { column: `c${(Number.isInteger(index) && index >= 0 ? index : 0) + 1}` };
	};
</script>

<!--
	The table: a horizontal scroller around its grid (`table.css`), the rows
	its one children container.
-->
{#snippet table({ block, children }: BlockSnippetPayload)}
	<div data-edytor-table-scroll>
		<div
			data-edytor-children
			data-edytor-table-grid
			style:grid-template-columns={templateOf(block)}
		>
			{#if children}{@render children()}{/if}
		</div>
	</div>
{/snippet}

<!-- A row: its cells, then a placeholder in each column it shows none of (`table.pad`). -->
{#snippet row({ block, children }: BlockSnippetPayload)}
	{@const labels = labelsOf.of(block.handle?.edytor)}
	<div data-edytor-children data-edytor-table-cells>
		{#if children}{@render children()}{/if}
		{#each padsOf(block) as column (column)}
			<!-- A pointer's way to a padded cell: the keyboard fills none (Tab skips it). -->
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div
				data-edytor-table-pad
				data-edytor-column={column}
				contenteditable="false"
				role="cell"
				aria-label={labels.emptyCell}
				style:grid-column={column + 1}
				style:grid-row="1"
				onmousedown={(event) => fillPad(block, column, event)}
			></div>
		{/each}
	</div>
{/snippet}

<!-- A cell: its text (its lines are line breaks), and any block a race left in it. -->
{#snippet cell({ content, children }: BlockSnippetPayload)}
	{@render content()}
	{#if children}<div data-edytor-children>{@render children()}</div>{/if}
{/snippet}
