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

	const labels = $derived(chrome.labels);
	const layout = $derived(chrome.layout);
	const line = $derived(chrome.line);
	const menuPlace = $derived(chrome.menuPlace);

	// The view turning readonly mid-drag drops the preview at once.
	$effect(() => {
		if (chrome.readonly) chrome.band.lock();
	});

	const px = (value: number | undefined) => (value === undefined ? undefined : `${value}px`);
</script>

<div
	role="presentation"
	data-edytor-table-chrome
	data-selecting={chrome.band.selecting ? 'true' : undefined}
>
	{#if chrome.shown && layout}
		{#each chrome.grips as place (place.kind)}
			{@const label = labels[`${place.kind}Menu`]}
			<!-- Centered on where the grip stands: its flex host is a point. -->
			<div
				data-edytor-table-grip-host={place.kind}
				style:left={px(place.x)}
				style:top={px(place.y)}
			>
				{#if grip}
					{@render grip({
						kind: place.kind,
						id: place.id,
						index: place.index,
						expanded: chrome.menu?.kind === place.kind,
						dragging: chrome.moving?.kind === place.kind,
						label,
						toggle: () => chrome.toggle(place.kind),
						grip: chrome.gripOf(place.kind),
						labels,
						chrome
					})}
				{:else}
					<button
						type="button"
						data-edytor-table-grip={place.kind}
						aria-label={label}
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
				style:left={px(line.left)}
				style:top={px(line.top)}
				style:width={px(line.width)}
				style:height={px(line.height)}
			></div>
		{/if}
		{#each chrome.bars as bar (bar.kind)}
			{@const label = bar.kind === 'row' ? labels.addRow : labels.addColumn}
			<div
				data-edytor-table-add-host={bar.kind}
				role="presentation"
				style:left={px(bar.left)}
				style:top={px(bar.top)}
				style:width={px(bar.width)}
				style:height={px(bar.height)}
				onmousedown={keepFocus}
			>
				{#if add}
					{@render add({ kind: bar.kind, label, add: () => chrome.add(bar.kind), labels })}
				{:else}
					<button
						type="button"
						data-edytor-table-add={bar.kind}
						aria-label={label}
						title={label}
						onclick={() => chrome.add(bar.kind)}
					></button>
				{/if}
			</div>
		{/each}
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
					style:left={px(column.left + column.width - 4)}
					style:top={px(layout.top)}
					style:height={px(layout.height)}
					{@attach chrome.band.press((event) => chrome.start(event, index))}
					onkeydown={(event) => chrome.key(event, index)}
				></div>
			{/if}
		{/each}
	{/if}
	{#if chrome.menu && menuPlace}
		<div data-edytor-table-menu-host style:left={px(menuPlace.left)} style:top={px(menuPlace.top)}>
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
