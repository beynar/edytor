<script lang="ts">
	import type { Snippet } from 'svelte';
	import { keepFocus } from '../chrome.js';
	import type { TableAddPayload, TableChrome, TableGripPayload } from './chrome.svelte.js';

	/**
	 * The table's chrome in the overlay (`TableChrome`): the `+` under and
	 * beside the hovered table, the grips of its hovered row and column (drag
	 * sources, `table.drag`, opening their menus on a click), their menus,
	 * the drop line of a grip's drag, and a resize band on each column's
	 * right edge. Over a table wider than its box, only what its box shows
	 * (`table.overflow`). A grip, a menu and a `+` are the plugin's `grip`,
	 * `menu` and `add` snippets when it has them: placed by the hosts here,
	 * their keys and ARIA the controller's attachments, as this markup's.
	 */
	let {
		chrome,
		grip,
		menu,
		add
	}: {
		chrome: TableChrome;
		grip?: Snippet<[TableGripPayload]>;
		menu?: Snippet<[TableChrome]>;
		add?: Snippet<[TableAddPayload]>;
	} = $props();

	const layout = $derived(chrome.layout);
	const labels = $derived(chrome.labels);
	const grips = $derived([chrome.rowGrip, chrome.columnGrip].filter((place) => place !== null));
	const bars = $derived(chrome.bars);
	const menuPlace = $derived(chrome.menuPlace);
	/** The drop line of a grip's drag: between two rows (columns), where the drop would land. */
	const line = $derived.by(() => {
		const move = chrome.moving;
		const gap = move?.gap ?? null;
		if (!move || gap === null || !layout) return null;
		if (move.kind === 'row') {
			const row = layout.rows[gap];
			const last = layout.rows[layout.rows.length - 1];
			const y = row ? row.top : last ? last.top + last.height : null;
			const { left, width } = chrome.span;
			return y === null ? null : { kind: 'row', gap, left, top: y, width };
		}
		const column = layout.columns[gap];
		const last = layout.columns[layout.columns.length - 1];
		const x = column ? column.left : last ? last.left + last.width : null;
		if (x === null || !chrome.inView(x)) return null;
		return { kind: 'column', gap, left: x, top: layout.top, height: layout.height };
	});

	// The view turning readonly mid-drag drops the preview at once.
	$effect(() => {
		if (chrome.readonly) chrome.lock();
	});

	/** A grip's snippet payload. */
	const gripPayload = (place: NonNullable<TableChrome['rowGrip']>): TableGripPayload => ({
		kind: place.kind,
		id: place.id,
		index: place.index,
		expanded: chrome.menu?.kind === place.kind,
		dragging: chrome.moving?.kind === place.kind,
		label: place.kind === 'row' ? labels.rowMenu : labels.columnMenu,
		toggle: () => chrome.toggle(place.kind),
		grip: chrome.gripOf(place.kind),
		labels,
		chrome
	});

	/** A `+`'s snippet payload. */
	const addPayload = (kind: 'row' | 'column'): TableAddPayload => ({
		kind,
		label: kind === 'row' ? labels.addRow : labels.addColumn,
		add: kind === 'row' ? chrome.addRow : chrome.addColumn,
		labels
	});
</script>

<div
	role="presentation"
	data-edytor-table-chrome
	data-selecting={chrome.selecting ? 'true' : undefined}
>
	{#if chrome.shown && layout}
		{#each grips as place (place.kind)}
			<!-- Centered on where the grip stands: its flex host is a point. -->
			<div
				data-edytor-table-grip-host={place.kind}
				style:left="{place.x}px"
				style:top="{place.y}px"
			>
				{#if grip}
					{@render grip(gripPayload(place))}
				{:else}
					<button
						type="button"
						data-edytor-table-grip={place.kind}
						aria-label={place.kind === 'row' ? labels.rowMenu : labels.columnMenu}
						{@attach chrome.gripOf(place.kind)}
					></button>
				{/if}
			</div>
		{/each}
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
		{#if bars.row}
			<div
				data-edytor-table-add-host="row"
				role="presentation"
				style:left="{bars.row.left}px"
				style:top="{bars.row.top}px"
				style:width="{bars.row.width}px"
				onmousedown={keepFocus}
			>
				{#if add}
					{@render add(addPayload('row'))}
				{:else}
					<button
						type="button"
						data-edytor-table-add="row"
						aria-label={labels.addRow}
						title={labels.addRow}
						onclick={() => chrome.addRow()}
					></button>
				{/if}
			</div>
		{/if}
		{#if bars.column}
			<div
				data-edytor-table-add-host="column"
				role="presentation"
				style:left="{bars.column.left}px"
				style:top="{bars.column.top}px"
				style:height="{bars.column.height}px"
				onmousedown={keepFocus}
			>
				{#if add}
					{@render add(addPayload('column'))}
				{:else}
					<button
						type="button"
						data-edytor-table-add="column"
						aria-label={labels.addColumn}
						title={labels.addColumn}
						onclick={() => chrome.addColumn()}
					></button>
				{/if}
			</div>
		{/if}
		{#each layout.columns as column, index (column.id)}
			{#if chrome.inView(column.left + column.width)}
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
	{#if chrome.menu && menuPlace}
		<div data-edytor-table-menu-host style:left="{menuPlace.left}px" style:top="{menuPlace.top}px">
			{#if menu}
				{@render menu(chrome)}
			{:else}
				<div class="edytor-table-menu" {@attach chrome.popup} {@attach chrome.keys}>
					{#each chrome.items as item (item.item.id)}
						<button
							type="button"
							class="edytor-table-menu-row"
							class:danger={item.danger}
							{...item.option}
							disabled={item.disabled}
							data-testid={`table-menu-${item.item.id}`}
							style:--table-menu-icon={item.icon}
							onmousemove={item.select}
							onclick={item.run}>{item.label}</button
						>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
