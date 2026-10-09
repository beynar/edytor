<script lang="ts">
	import { iconOf } from '../icons.js';
	import { BLOCK_PALETTE } from '$lib/block/colors.js';
	import type { BlockMenuColor, BlockMenuController } from './BlockMenuController.svelte.js';

	import type { Snippet } from 'svelte';
	let {
		controller,
		menu
	}: { controller: BlockMenuController; menu?: Snippet<[BlockMenuController]> } = $props();
	const rows = $derived(controller.rows);
	const labels = $derived(controller.labels);
	// An editor turning readonly closes the menu (its actions would be refused).
	$effect(() => {
		if (controller.isOpen && controller.readonly) controller.close(false);
	});

	/** A colour row's swatch: its text colour on a white square, or its background. */
	const swatch = (row: BlockMenuColor) =>
		row.value === null
			? undefined
			: `var(--edytor-${row.field}-${row.value}, ${BLOCK_PALETTE[row.value][row.field]})`;
</script>

<!--
	The keys, the ids, the roles and the publication to the view's root are
	the controller's attachments (`keys`, `popup`, `flyoutMenu`, `option`):
	a custom `menu` that uses them behaves as this one.
-->
{#if controller.isOpen && menu}
	{@render menu(controller)}
{:else if controller.isOpen}
	<div class="block-menu-frame">
		<div class="block-menu" data-testid="block-menu" data-edytor-block-menu tabindex="-1">
			<div class="block-menu-search">
				<input
					placeholder={labels.search}
					aria-label={labels.searchLabel}
					value={controller.query}
					{@attach controller.keys}
					oninput={(event) => controller.search(event.currentTarget.value)}
				/>
			</div>
			<div class="block-menu-rows" role="menu" aria-label={labels.menu} {@attach controller.popup}>
				{#if !controller.query}
					<div class="block-menu-heading" role="presentation">
						{controller.currentKind?.label ?? labels.block}
					</div>
				{/if}
				{#each rows as row, index ('field' in row ? `color:${row.id}` : 'value' in row ? `kind:${row.id}` : row.id)}
					{#if 'field' in row}
						{#if index === 0 || !('field' in rows[index - 1]!)}
							<div class="block-menu-heading" role="presentation">{labels.color}</div>
						{/if}
						<button
							type="button"
							{...controller.option(index)}
							class="block-menu-row block-menu-color"
							data-field={row.field}
							data-current={controller.isCurrentColor(row)}
							data-testid={`block-menu-${row.id}`}
							style:--block-menu-swatch={swatch(row)}
							onmousemove={() => (controller.selectedIndex = index)}
							onclick={() => controller.paint(row)}>{row.label}</button
						>
					{:else if 'value' in row}
						{#if index === 0 || !('value' in rows[index - 1]!) || 'field' in rows[index - 1]!}
							<div class="block-menu-heading" role="presentation">{labels.turnInto}</div>
						{/if}
						<button
							type="button"
							{...controller.option(index)}
							class="block-menu-row"
							style:--block-menu-icon={iconOf(row.id)}
							onmousemove={() => (controller.selectedIndex = index)}
							onclick={() => controller.turnInto(row)}>{row.label}</button
						>
					{:else}
						{#if row.id === 'delete' || row.id === 'duplicate'}<div
								class="block-menu-divider"
								role="separator"
							></div>{/if}
						<button
							type="button"
							{...controller.option(index)}
							data-checked={row.checked}
							class="block-menu-row"
							class:danger={row.danger}
							data-hint={row.submenu ? undefined : row.hint}
							data-submenu={row.submenu ? 'true' : undefined}
							data-testid={`block-menu-${row.id}`}
							style:--block-menu-icon={iconOf(row.icon)}
							onmouseenter={() => {
								controller.selectedIndex = index;
								if (row.submenu) controller.openFlyout(row.submenu);
								else controller.flyout = false;
							}}
							onclick={() => (row.submenu ? controller.openFlyout(row.submenu) : row.run?.())}
							>{row.label}</button
						>
					{/if}
				{/each}
				{#if rows.length === 0}
					<div class="block-menu-empty" role="presentation">{labels.noResults}</div>
				{/if}
			</div>
		</div>
		{#if controller.flyout === 'turn'}
			<div
				class="block-menu block-menu-flyout"
				role="menu"
				aria-label={labels.turnInto}
				{@attach controller.flyoutMenu}
			>
				<div class="block-menu-rows" role="presentation">
					<div class="block-menu-heading" role="presentation">{labels.turnInto}</div>
					{#each controller.kinds as kind, index (kind.id)}
						<button
							type="button"
							{...controller.option(index, true)}
							class="block-menu-row"
							data-current={kind === controller.currentKind}
							onmousemove={() => (controller.flyoutIndex = index)}
							style:--block-menu-icon={iconOf(kind.id)}
							onclick={() => controller.turnInto(kind)}>{kind.label}</button
						>
					{/each}
				</div>
			</div>
		{:else if controller.flyout === 'color'}
			<div
				class="block-menu block-menu-flyout"
				role="menu"
				aria-label={labels.color}
				{@attach controller.flyoutMenu}
			>
				<div class="block-menu-rows" role="presentation">
					{#each controller.colors as color, index (color.id)}
						{#if index === 0 || color.field !== controller.colors[index - 1]!.field}
							<div class="block-menu-heading" role="presentation">
								{color.field === 'color' ? labels.textColor : labels.backgroundColor}
							</div>
						{/if}
						<button
							type="button"
							{...controller.option(index, true)}
							class="block-menu-row block-menu-color"
							data-field={color.field}
							data-current={controller.isCurrentColor(color)}
							data-testid={`block-menu-${color.id}`}
							style:--block-menu-swatch={swatch(color)}
							onmousemove={() => (controller.flyoutIndex = index)}
							onclick={() => controller.paint(color)}>{color.label}</button
						>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.block-menu-frame {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI Variable Display',
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
		font-size: 14px;
		line-height: 20px;
		color: #2c2c2b;
	}
	.block-menu {
		width: 265px;
		max-height: min(70vh, 480px);
		display: flex;
		flex-direction: column;
		border-radius: 10px;
		background: #fff;
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px rgba(84, 72, 49, 0.08);
		overflow: hidden;
		transform-origin: top left;
		animation: block-menu-in 140ms cubic-bezier(0.2, 0, 0, 1);
	}
	/* Never taller than the viewport: it scrolls inside, placed within it (`place`). */
	.block-menu-flyout {
		width: 220px;
		max-height: min(480px, calc(100vh - 16px));
	}
	@keyframes block-menu-in {
		from {
			opacity: 0;
			transform: scale(0.98);
		}
	}
	.block-menu-search {
		padding: 8px 8px 4px;
	}
	.block-menu-search input {
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border-radius: 6px;
		background: rgba(242, 241, 238, 0.6);
		box-shadow: inset 0 0 0 1px rgba(15, 15, 15, 0.1);
		color: inherit;
		font: inherit;
		outline: 0;
	}
	.block-menu-search input:focus {
		box-shadow:
			inset 0 0 0 1px rgba(35, 131, 226, 0.57),
			0 0 0 2px rgba(35, 131, 226, 0.35);
	}
	.block-menu-rows {
		overflow-y: auto;
		padding: 4px;
	}
	.block-menu-heading {
		padding: 6px 8px 4px;
		color: #73726e;
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
		user-select: none;
	}
	.block-menu-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border-radius: 6px;
		color: inherit;
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}
	.block-menu-row::before {
		content: '';
		flex: none;
		width: 20px;
		height: 20px;
		background: #383836;
		-webkit-mask: var(--block-menu-icon) center / 20px no-repeat;
		mask: var(--block-menu-icon) center / 20px no-repeat;
	}
	.block-menu-row[data-hint]::after,
	.block-menu-row[data-submenu]::after,
	.block-menu-row[data-current='true']::after {
		margin-left: auto;
		color: #73726e;
		font-size: 12px;
	}
	.block-menu-row[data-hint]::after {
		content: attr(data-hint);
	}
	.block-menu-row[data-submenu]::after {
		content: '›';
		font-size: 16px;
	}
	/* A kind's switch (a table's Header row): Notion's small toggle. */
	.block-menu-row[data-checked]::after {
		content: '';
		flex: none;
		margin-left: auto;
		width: 26px;
		height: 14px;
		border-radius: 7px;
		background:
			radial-gradient(circle at 7px 50%, #fff 5px, transparent 5.5px), rgba(55, 53, 47, 0.2);
	}
	.block-menu-row[data-checked='true']::after {
		background: radial-gradient(circle at 19px 50%, #fff 5px, transparent 5.5px), #2383e2;
	}
	.block-menu-row[data-current='true']::after {
		content: '✓';
		color: #2c2c2b;
	}
	.block-menu-row[data-selected='true'],
	.block-menu-row:hover {
		background: rgba(33, 27, 23, 0.06);
	}
	.block-menu-row.danger:hover,
	.block-menu-row.danger[data-selected='true'] {
		color: #cf5148;
	}
	.block-menu-row.danger:hover::before,
	.block-menu-row.danger[data-selected='true']::before {
		background: #cf5148;
	}
	/*
	 * A colour row's swatch, as Notion draws it: an "A" in the text colour on
	 * a bordered square, or a square filled with the background.
	 */
	.block-menu-color::before {
		content: 'A';
		display: grid;
		place-items: center;
		box-sizing: border-box;
		border-radius: 4px;
		box-shadow: inset 0 0 0 1px rgba(15, 15, 15, 0.1);
		background: transparent;
		-webkit-mask: none;
		mask: none;
		color: var(--block-menu-swatch, #2c2c2b);
		font-size: 13px;
		font-weight: 500;
	}
	.block-menu-color[data-field='background']::before {
		content: '';
		background: var(--block-menu-swatch, #fff);
	}
	.block-menu-divider {
		height: 1px;
		margin: 4px -4px;
		background: rgba(28, 19, 1, 0.08);
	}
	.block-menu-empty {
		padding: 6px 8px;
		color: #73726e;
	}
</style>
