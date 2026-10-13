<script lang="ts">
	import {
		Edytor,
		createBlockMenuPlugin,
		type BlockMenuController,
		type JSONDoc,
		type Plugin
	} from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	// The block menu drawn with the snippet below.
	const blockMenu = createBlockMenuPlugin({ menu });
</script>

<!-- A dark command palette: the actions in a column, a flyout of chips beside it. -->
{#snippet menu(controller: BlockMenuController)}
	<div class="menu" data-edytor-block-menu>
		<input
			aria-label="Search actions"
			placeholder="Search…"
			value={controller.query}
			oninput={(event) => controller.search(event.currentTarget.value)}
			{@attach controller.keys}
		/>
		<div class="rows" aria-label="Block actions" {@attach controller.popup}>
			{#each controller.rows as row, index (`${index}:${row.id}`)}
				<button
					class="row"
					data-selected={controller.index === index}
					data-danger={'danger' in row && row.danger}
					{@attach controller.option(index)}
					onmousemove={() => (controller.index = index)}
					onclick={() => {
						controller.index = index;
						controller.run(row);
					}}
				>
					{row.label}
					{#if 'submenu' in row && row.submenu}<span class="more">›</span>{/if}
					{#if 'hint' in row && row.hint}<span class="hint">{row.hint}</span>{/if}
				</button>
			{/each}
			{#if controller.rows.length === 0}
				<div class="none" role="status">No match</div>
			{/if}
		</div>
		{#if controller.flyout}
			<div class="flyout" data-edytor-block-menu-flyout {@attach controller.flyoutMenu}>
				{#each controller.flyoutRows as row, index (row.id)}
					<button
						class="chip"
						data-selected={controller.flyoutIndex === index}
						{@attach controller.option(index, true)}
						onmousemove={() => (controller.flyoutIndex = index)}
						onclick={() => {
							controller.flyoutIndex = index;
							controller.run(row);
						}}
					>
						{row.label}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<Edytor {value} plugins={[blockMenu, ...plugins]} aria-label="Block menu demo" />

<style>
	.menu {
		width: 220px;
		padding: 8px;
		border-radius: 12px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
		font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	input {
		box-sizing: border-box;
		width: 100%;
		margin-bottom: 6px;
		padding: 6px 8px;
		border: 1px solid #3d444d;
		border-radius: 8px;
		background: #151b23;
		color: inherit;
		font: inherit;
		outline: none;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row,
	.chip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.row[data-danger='true'] {
		color: #ff7b72;
	}
	.row[data-selected='true'],
	.chip[data-selected='true'] {
		background: #2f81f7;
		color: #fff;
	}
	.more,
	.hint {
		margin-left: auto;
		color: #9198a1;
		font-size: 11px;
	}
	.row[data-selected='true'] .more,
	.row[data-selected='true'] .hint {
		color: #dbe9ff;
	}
	.none {
		padding: 4px 8px;
		color: #9198a1;
	}
	.flyout {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		width: 220px;
		padding: 8px;
		border-radius: 12px;
		background: #1f2328;
		color: #e6edf3;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
	}
	.chip {
		padding: 3px 10px;
		border: 1px solid #3d444d;
		border-radius: 999px;
	}
</style>
