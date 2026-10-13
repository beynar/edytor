<script module lang="ts">
	/** A table menu row's icon, by its id. */
	export const TABLE_ICONS: Record<string, string> = {
		'insert-above': 'action.up',
		'insert-below': 'action.down',
		'move-up': 'action.up',
		'move-down': 'action.down',
		'insert-left': 'table.left',
		'insert-right': 'table.right',
		'move-left': 'table.left',
		'move-right': 'table.right',
		'delete-row': 'action.delete',
		'delete-column': 'action.delete'
	};
</script>

<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { css } from './ui.js';
	import { words } from './words.svelte.js';
	import { iconOf } from './icons.js';
	import { keepFocus } from './keepFocus.js';
	import type { TableAddPayload, TableChrome, TableGripPayload } from 'edytor';

	/**
	 * Notion's table chrome, drawn for `createTablePlugin({ grip, menu, add })`:
	 * one of a row's or a column's grip (`grip`), its menu (`menu`), or the
	 * `+` under or beside the table (`add`).
	 */
	let { grip, menu, add }: { grip?: TableGripPayload; menu?: TableChrome; add?: TableAddPayload } =
		$props();
</script>

{#if grip}
	<Button
		variant="ghost"
		class="table-grip"
		data-edytor-table-grip={grip.kind}
		aria-label={words.table[`${grip.kind}Menu`]}
		{@attach grip.grip}
	></Button>
{:else if menu}
	<div
		class="table-menu"
		aria-label={words.table[`${menu.menu?.kind ?? 'row'}Menu`]}
		{@attach menu.popup}
		{@attach menu.keys}
	>
		{#each menu.items as item (item.item.id)}
			<Button
				variant="ghost"
				class={['table-menu-row', item.danger && 'danger']}
				data-selected={item.selected}
				disabled={item.disabled}
				{@attach item.option}
				data-testid={`table-menu-${item.item.id}`}
				onmousemove={item.select}
				onclick={item.run}
				style={css({ '--table-menu-icon': iconOf(TABLE_ICONS[item.item.id] ?? '') })}
				>{words.table[item.item.id.replace(/-./g, (m) => m[1]!.toUpperCase())]}</Button
			>
		{/each}
	</div>
{:else if add}
	<Button
		variant="ghost"
		class="table-add"
		data-edytor-table-add={add.kind}
		aria-label={add.kind === 'row' ? words.table.addRow : words.table.addColumn}
		title={add.kind === 'row' ? words.table.addRow : words.table.addColumn}
		onmousedown={keepFocus}
		onclick={add.add}
	></Button>
{/if}

<style>
	:global(.table-grip),
	:global(.table-add) {
		margin: 0;
		padding: 0;
		border: none;
	}
	:global(.table-grip) {
		width: 18px;
		height: 24px;
		border-radius: 4px;
		background: var(--edytor-table-grip-background, var(--popover));
		box-shadow:
			0 0 0 1px var(--border),
			0 2px 4px var(--border);
		color: var(--muted-foreground);
		cursor: grab;
	}
	:global(.table-grip[data-dragging='true']) {
		cursor: grabbing;
	}
	:global(.table-grip[data-edytor-table-grip='column']) {
		width: 24px;
		height: 18px;
	}
	:global(.table-grip::before) {
		content: '⋮⋮';
		font-size: 10px;
		letter-spacing: -2px;
		line-height: 24px;
	}
	:global(.table-grip[data-edytor-table-grip='column']::before) {
		content: '⋯';
		font-size: 14px;
		letter-spacing: 0;
		line-height: 18px;
	}
	:global(.table-add) {
		display: block;
		width: 100%;
		height: 16px;
		border-radius: 3px;
		background: var(--accent);
		color: var(--muted-foreground);
		cursor: pointer;
		opacity: 0;
		transition: opacity 80ms ease;
	}
	:global(.table-add[data-edytor-table-add='column']) {
		width: 16px;
		height: 100%;
	}
	:global(.table-add::before) {
		content: '+';
		font-size: 14px;
	}
	:global(.table-add:hover),
	:global(.table-add:focus-visible) {
		opacity: 1;
		background: var(--accent);
	}
	.table-menu {
		min-width: 180px;
		padding: 6px;
		border-radius: 10px;
		background: var(--edytor-menu-background, var(--popover));
		box-shadow:
			0 0 0 1px var(--accent),
			0 3px 6px var(--border),
			0 9px 24px var(--border);
		pointer-events: auto;
	}
	:global(.table-menu-row) {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--popover-foreground);
		font: inherit;
		font-size: 14px;
		text-align: start;
		cursor: pointer;
	}
	:global(.table-menu-row::before) {
		content: '';
		flex: none;
		width: 20px;
		height: 20px;
		background: var(--popover-foreground);
		-webkit-mask: var(--table-menu-icon) center / 20px no-repeat;
		mask: var(--table-menu-icon) center / 20px no-repeat;
	}
	/* The menu holds the keys; its keyboard's row shows as hovered. */
	.table-menu:focus {
		outline: none;
	}
	:global(.table-menu-row:hover:not(:disabled)),
	:global(.table-menu-row[data-selected='true']:not(:disabled)),
	:global(.table-menu-row:focus-visible) {
		background: var(--accent);
		outline: none;
	}
	:global(.table-menu-row:disabled) {
		opacity: 0.4;
		cursor: default;
	}
	:global(.table-menu-row.danger:hover:not(:disabled)) {
		color: var(--destructive);
	}
	:global(.table-menu-row.danger:hover:not(:disabled)::before) {
		background: var(--destructive);
	}
</style>
