<script lang="ts">
	import {
		Edytor,
		createTablePlugin,
		type JSONDoc,
		type Plugin,
		type TableAddPayload,
		type TableChrome,
		type TableGripPayload
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The words of the menu's rows (the package carries none).
	const LABELS: Record<string, string> = {
		'insert-above': 'Insert above',
		'insert-below': 'Insert below',
		'move-up': 'Move up',
		'move-down': 'Move down',
		'delete-row': 'Delete row',
		'insert-left': 'Insert left',
		'insert-right': 'Insert right',
		'move-left': 'Move left',
		'move-right': 'Move right',
		'delete-column': 'Delete column'
	};

	// A table with its grips as pills, its menu as a dark list and its + bars as dashed lines.
	const table = createTablePlugin({ grip, menu, add });
</script>

<!-- A grip: a small pill, drag it to move, click it for its menu. -->
{#snippet grip(grip: TableGripPayload)}
	<button
		type="button"
		class="grip"
		data-kind={grip.kind}
		aria-label="{grip.kind === 'row' ? 'Row' : 'Column'} {grip.index + 1} menu"
		{@attach grip.grip}
	>
		{grip.index + 1}
	</button>
{/snippet}

<!-- The menu a grip opens: a dark list. -->
{#snippet menu(menu: TableChrome)}
	<div class="menu" aria-label="{menu.menu?.kind ?? 'row'} actions" {@attach menu.popup} {@attach menu.keys}>
		{#each menu.items as item (item.item.id)}
			<button
				type="button"
				class="row"
				class:danger={item.danger}
				data-selected={item.selected}
				disabled={item.disabled}
				onmousemove={item.select}
				onclick={item.run}
				{@attach item.option}
			>
				{LABELS[item.item.id] ?? item.item.id}
			</button>
		{/each}
	</div>
{/snippet}

<!-- The + under and beside the table: a dashed line that fills in on hover. -->
{#snippet add(add: TableAddPayload)}
	<button
		type="button"
		class="add"
		data-kind={add.kind}
		aria-label={add.kind === 'row' ? 'Add a row' : 'Add a column'}
		onmousedown={(event) => event.preventDefault()}
		onclick={add.add}
	>
		+
	</button>
{/snippet}

<Edytor {value} plugins={[table, ...plugins]} aria-label="Table demo" />

<style>
	.grip {
		display: grid;
		place-items: center;
		min-width: 22px;
		height: 18px;
		margin: 0;
		padding: 0 6px;
		border: none;
		border-radius: 999px;
		background: #5b4bd6;
		color: #fff;
		font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		cursor: grab;
	}
	.grip[data-dragging='true'] {
		cursor: grabbing;
	}
	.grip:hover {
		background: #4638b8;
	}
	.menu {
		min-width: 160px;
		padding: 6px;
		border-radius: 12px;
		background: #1f2328;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
		pointer-events: auto;
	}
	.menu:focus {
		outline: none;
	}
	.row {
		display: block;
		width: 100%;
		padding: 5px 10px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: #e6edf3;
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
		text-align: start;
		cursor: pointer;
	}
	.row[data-selected='true']:not(:disabled) {
		background: #5b4bd6;
		color: #fff;
	}
	.row.danger {
		color: #ff7b72;
	}
	.row:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.add {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 1px dashed #b9b2f0;
		border-radius: 4px;
		background: transparent;
		color: #5b4bd6;
		font: 600 14px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		cursor: pointer;
		opacity: 0;
		transition: opacity 80ms ease;
	}
	.add:hover,
	.add:focus-visible {
		opacity: 1;
		background: #efecfd;
	}
</style>
