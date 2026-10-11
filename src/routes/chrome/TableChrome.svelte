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
	import { iconOf } from './icons.js';
	import { keepFocus } from './keepFocus.js';
	import type { TableAddPayload, TableChrome, TableGripPayload } from '$lib/index.js';

	/**
	 * Notion's table chrome, drawn for `createTablePlugin({ grip, menu, add })`:
	 * one of a row's or a column's grip (`grip`), its menu (`menu`), or the
	 * `+` under or beside the table (`add`).
	 */
	let { grip, menu, add }: { grip?: TableGripPayload; menu?: TableChrome; add?: TableAddPayload } =
		$props();
</script>

{#if grip}
	<button
		type="button"
		class="table-grip"
		data-edytor-table-grip={grip.kind}
		aria-label={grip.label}
		{@attach grip.grip}
	></button>
{:else if menu}
	<div class="table-menu" {@attach menu.popup} {@attach menu.keys}>
		{#each menu.items as item (item.item.id)}
			<button
				type="button"
				class="table-menu-row"
				class:danger={item.danger}
				{...item.option}
				disabled={item.disabled}
				data-testid={`table-menu-${item.item.id}`}
				style:--table-menu-icon={iconOf(TABLE_ICONS[item.item.id] ?? '')}
				onmousemove={item.select}
				onclick={item.run}>{item.label}</button
			>
		{/each}
	</div>
{:else if add}
	<button
		type="button"
		class="table-add"
		data-edytor-table-add={add.kind}
		aria-label={add.label}
		title={add.label}
		onmousedown={keepFocus}
		onclick={add.add}
	></button>
{/if}

<style>
	.table-grip,
	.table-add {
		margin: 0;
		padding: 0;
		border: none;
	}
	.table-grip {
		width: 18px;
		height: 24px;
		border-radius: 4px;
		background: var(--edytor-table-grip-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.1),
			0 2px 4px rgba(15, 15, 15, 0.1);
		color: rgba(55, 53, 47, 0.45);
		cursor: grab;
	}
	.table-grip:global([data-dragging='true']) {
		cursor: grabbing;
	}
	.table-grip[data-edytor-table-grip='column'] {
		width: 24px;
		height: 18px;
	}
	.table-grip::before {
		content: '⋮⋮';
		font-size: 10px;
		letter-spacing: -2px;
		line-height: 24px;
	}
	.table-grip[data-edytor-table-grip='column']::before {
		content: '⋯';
		font-size: 14px;
		letter-spacing: 0;
		line-height: 18px;
	}
	.table-add {
		display: block;
		width: 100%;
		height: 16px;
		border-radius: 3px;
		background: rgba(55, 53, 47, 0.04);
		color: rgba(55, 53, 47, 0.45);
		cursor: pointer;
		opacity: 0;
		transition: opacity 80ms ease;
	}
	.table-add[data-edytor-table-add='column'] {
		width: 16px;
		height: 100%;
	}
	.table-add::before {
		content: '+';
		font-size: 14px;
	}
	.table-add:hover,
	.table-add:focus-visible {
		opacity: 1;
		background: rgba(55, 53, 47, 0.08);
	}
	.table-menu {
		min-width: 180px;
		padding: 6px;
		border-radius: 10px;
		background: var(--edytor-menu-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.05),
			0 3px 6px rgba(15, 15, 15, 0.1),
			0 9px 24px rgba(15, 15, 15, 0.2);
		pointer-events: auto;
	}
	.table-menu-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: rgb(55, 53, 47);
		font: inherit;
		font-size: 14px;
		text-align: start;
		cursor: pointer;
	}
	.table-menu-row::before {
		content: '';
		flex: none;
		width: 20px;
		height: 20px;
		background: #383836;
		-webkit-mask: var(--table-menu-icon) center / 20px no-repeat;
		mask: var(--table-menu-icon) center / 20px no-repeat;
	}
	/* The menu holds the keys; its keyboard's row shows as hovered. */
	.table-menu:focus {
		outline: none;
	}
	.table-menu-row:hover:not(:disabled),
	.table-menu-row[data-selected='true']:not(:disabled),
	.table-menu-row:focus-visible {
		background: rgba(33, 27, 23, 0.06);
		outline: none;
	}
	.table-menu-row:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.table-menu-row.danger:hover:not(:disabled) {
		color: #cf5148;
	}
	.table-menu-row.danger:hover:not(:disabled)::before {
		background: #cf5148;
	}
</style>
