<script lang="ts">
	import { iconOf } from '../icons.js';
	import type { TableChrome } from './chrome.svelte.js';

	/**
	 * The table's chrome in the overlay (`TableChrome`): the `+` under and
	 * beside the hovered table, the grips of its hovered row and column, their
	 * menus, and a resize band on each column's right edge.
	 */
	let { chrome }: { chrome: TableChrome } = $props();

	const layout = $derived(chrome.layout);
	const labels = $derived(chrome.labels);
	const hoveredRow = $derived(
		layout?.rows.find(
			(row) => row.id === (chrome.menu?.kind === 'row' ? chrome.menu.row : chrome.hovered?.row)
		)
	);
	const hoveredColumn = $derived.by(() => {
		const index =
			chrome.menu?.kind === 'column' ? chrome.menu.column : (chrome.hovered?.column ?? null);
		return index === null
			? undefined
			: layout?.columns[index] && { index, ...layout.columns[index] };
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
				style:left="{layout.left - 9}px"
				style:top="{hoveredRow.top + hoveredRow.height / 2 - 12}px"
				onmousedown={(event) => event.preventDefault()}
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
				style:left="{hoveredColumn.left + hoveredColumn.width / 2 - 12}px"
				style:top="{layout.top - 9}px"
				onmousedown={(event) => event.preventDefault()}
				onclick={() =>
					chrome.open({ kind: 'column', table: layout.table, column: hoveredColumn.index })}
			></button>
		{/if}
		<button
			type="button"
			data-edytor-table-add="row"
			aria-label={labels.addRow}
			title={labels.addRow}
			style:left="{layout.left}px"
			style:top="{layout.top + layout.height + 2}px"
			style:width="{layout.width}px"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => chrome.addRow()}
		></button>
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
		{#each layout.columns as column, index (column.id)}
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
