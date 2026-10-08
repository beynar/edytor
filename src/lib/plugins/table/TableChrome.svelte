<script lang="ts">
	import { iconOf } from '../icons.js';
	import type { TableChrome } from './chrome.svelte.js';

	/**
	 * The table's chrome in the overlay (`TableChrome`): the `+` under and
	 * beside the hovered table, the grips of its hovered row and column (drag
	 * sources, `table.drag`, opening their menus on a click), their menus,
	 * the drop line of a grip's drag, and a resize band on each column's
	 * right edge. Over a table wider than its box, only what its box shows
	 * (`table.overflow`).
	 */
	let { chrome }: { chrome: TableChrome } = $props();

	const layout = $derived(chrome.layout);
	const labels = $derived(chrome.labels);
	/** The grid's part its box shows: a band or a grip outside it is not shown. */
	const inView = (x: number) => !!layout && x >= layout.view.left - 1 && x <= layout.view.right + 1;
	/** The grid's visible span, horizontally. */
	const span = $derived.by(() => {
		if (!layout) return { left: 0, width: 0 };
		const left = Math.max(layout.left, layout.view.left);
		const right = Math.min(layout.left + layout.width, layout.view.right);
		return { left, width: Math.max(0, right - left) };
	});
	const hoveredRow = $derived(layout?.rows.find((row) => row.id === chrome.gripRow));
	const hoveredColumn = $derived.by(() => {
		const index = chrome.gripColumn;
		const column = index === null ? undefined : layout?.columns[index];
		// The grip a drag started from stays (its source), even scrolled out of view.
		if (index === null || !column) return undefined;
		const source = chrome.moving?.kind === 'column';
		return source || inView(column.left + column.width / 2) ? { index, ...column } : undefined;
	});
	/** The drop line of a grip's drag: between two rows (columns), where the drop would land. */
	const line = $derived.by(() => {
		const move = chrome.moving;
		const gap = move?.gap ?? null;
		if (!move || gap === null || !layout) return null;
		if (move.kind === 'row') {
			const row = layout.rows[gap];
			const last = layout.rows[layout.rows.length - 1];
			const y = row ? row.top : last ? last.top + last.height : null;
			return y === null ? null : { kind: 'row', gap, left: span.left, top: y, width: span.width };
		}
		const column = layout.columns[gap];
		const last = layout.columns[layout.columns.length - 1];
		const x = column ? column.left : last ? last.left + last.width : null;
		if (x === null || !inView(x)) return null;
		return { kind: 'column', gap, left: x, top: layout.top, height: layout.height };
	});
	/** Where the open menu stands: under its grip. */
	const menuAt = $derived.by(() => {
		const menu = chrome.menu;
		if (!menu || !layout) return null;
		if (menu.kind === 'row') {
			const row = layout.rows.find((r) => r.id === menu.row);
			return row ? { left: layout.left - 9, top: row.top + Math.min(row.height, 28) } : null;
		}
		const column = layout.columns[menu.column];
		return column ? { left: column.left + column.width / 2 - 12, top: layout.top + 10 } : null;
	});

	// The view turning readonly mid-drag drops the preview at once.
	$effect(() => {
		if (chrome.readonly) chrome.lock();
	});

	/**
	 * Escape in a grip's menu, or on a grip (a grip takes the focus a press
	 * gives it: preventing its `mousedown` would stop its native drag), closes
	 * the menu and gives the keys back to the editor.
	 */
	const onkeydown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		chrome.close();
	};
</script>

<div
	role="presentation"
	data-edytor-table-chrome
	data-selecting={chrome.selecting ? 'true' : undefined}
>
	{#if chrome.shown && layout}
		{#if hoveredRow}
			<button
				type="button"
				data-edytor-table-grip="row"
				aria-label={labels.rowMenu}
				aria-haspopup="menu"
				aria-expanded={chrome.menu?.kind === 'row'}
				data-dragging={chrome.moving?.kind === 'row' ? 'true' : undefined}
				style:left="{layout.left - 9}px"
				style:top="{hoveredRow.top + hoveredRow.height / 2 - 12}px"
				use:chrome.grip={'row'}
				{onkeydown}
				onclick={() => chrome.open({ kind: 'row', table: layout.table, row: hoveredRow.id })}
			></button>
		{/if}
		{#if hoveredColumn}
			<button
				type="button"
				data-edytor-table-grip="column"
				aria-label={labels.columnMenu}
				aria-haspopup="menu"
				aria-expanded={chrome.menu?.kind === 'column'}
				data-dragging={chrome.moving?.kind === 'column' ? 'true' : undefined}
				style:left="{hoveredColumn.left + hoveredColumn.width / 2 - 12}px"
				style:top="{layout.top - 9}px"
				use:chrome.grip={'column'}
				{onkeydown}
				onclick={() =>
					chrome.open({ kind: 'column', table: layout.table, column: hoveredColumn.index })}
			></button>
		{/if}
		{#if line}
			<div
				data-edytor-table-drop={line.kind}
				data-gap={line.gap}
				aria-hidden="true"
				style:left="{line.kind === 'row' ? line.left : line.left - 2}px"
				style:top="{line.kind === 'row' ? line.top - 2 : line.top}px"
				style:width={line.kind === 'row' ? `${line.width}px` : undefined}
				style:height={line.kind === 'column' ? `${line.height}px` : undefined}
			></div>
		{/if}
		<button
			type="button"
			data-edytor-table-add="row"
			aria-label={labels.addRow}
			title={labels.addRow}
			style:left="{span.left}px"
			style:top="{layout.top + layout.height + 2}px"
			style:width="{span.width}px"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => chrome.addRow()}
		></button>
		{#if inView(layout.left + layout.width)}
			<button
				type="button"
				data-edytor-table-add="column"
				aria-label={labels.addColumn}
				title={labels.addColumn}
				style:left="{layout.left + layout.width + 2}px"
				style:top="{layout.top}px"
				style:height="{layout.height}px"
				onmousedown={(event) => event.preventDefault()}
				onclick={() => chrome.addColumn()}
			></button>
		{/if}
		{#each layout.columns as column, index (column.id)}
			{#if inView(column.left + column.width)}
				<!-- A focusable separator is a widget (WAI-ARIA window splitter): its keys resize. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					data-edytor-table-resize={index}
					role="separator"
					tabindex="0"
					aria-label={labels.resize}
					aria-orientation="vertical"
					aria-valuenow={Math.round(column.width)}
					aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
					data-dragging={chrome.drag?.column === index ? 'true' : undefined}
					style:left="{column.left + column.width - 4}px"
					style:top="{layout.top}px"
					style:height="{layout.height}px"
					onpointerdown={(event) => chrome.start(event, index)}
					onmousedown={(event) => chrome.mousedown(event, index)}
					onkeydown={(event) => chrome.key(event, index)}
				></div>
			{/if}
		{/each}
	{/if}
	{#if chrome.menu && menuAt}
		<div
			class="edytor-table-menu"
			role="menu"
			tabindex="-1"
			aria-label={chrome.menu.kind === 'row' ? labels.rowMenu : labels.columnMenu}
			data-edytor-table-menu={chrome.menu.kind}
			style:left="{menuAt.left}px"
			style:top="{menuAt.top}px"
			{onkeydown}
		>
			{#each chrome.rows as row (row.id)}
				<button
					type="button"
					role="menuitem"
					class="edytor-table-menu-row"
					class:danger={row.danger}
					disabled={!row.isEnabled()}
					data-testid={`table-menu-${row.id}`}
					style:--table-menu-icon={iconOf(row.icon)}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => chrome.runRow(row)}>{row.label}</button
				>
			{/each}
		</div>
	{/if}
</div>
