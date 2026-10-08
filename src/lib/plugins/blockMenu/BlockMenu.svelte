<script lang="ts">
	import { iconOf } from '../icons.js';
	import { keepInView } from '../keepInView.js';
	import type { BlockMenuController } from './BlockMenuController.svelte.js';

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

	/**
	 * The keyboard's row (the flyout's while it is open), once its element is
	 * in the page: the search field, which holds the keyboard, names it.
	 */
	let frame = $state<HTMLElement>();
	let active = $state<string>();
	$effect(() => {
		if (!controller.isOpen || menu) return void (active = undefined);
		const row = controller.flyout
			? controller.kinds[controller.flyoutIndex]
			: rows[controller.selectedIndex];
		const id = row && controller.rowId(row, controller.flyout);
		active = id && frame?.ownerDocument.getElementById(id) ? id : undefined;
	});
	/**
	 * The open default menu, published to the view's root (`edytor.popups`),
	 * the grip that opened it told so. A custom `menu` owns its own ARIA.
	 */
	$effect(() => {
		const { block } = controller;
		if (!block || menu || !frame) return;
		controller.publish({
			id: controller.menuId,
			haspopup: 'menu',
			opener: { block: block.id, control: 'grip' }
		});
		return () => controller.publish(null);
	});

	const focusOnMount = (node: HTMLInputElement) => {
		node.focus({ preventScroll: true });
	};

	const onkeydown = (event: KeyboardEvent) => {
		const { key } = event;
		const count = rows.length;
		const arrow = key === 'ArrowDown' || key === 'ArrowUp';
		/** One arrow step through `length` rows, wrapping. */
		const step = (index: number, length: number) =>
			(index + (key === 'ArrowDown' ? 1 : length - 1)) % length;
		if (key === 'Escape') {
			event.preventDefault();
			if (controller.flyout) controller.flyout = false;
			else controller.close();
		} else if (controller.flyout && arrow) {
			// In the flyout, the arrows walk its kinds.
			event.preventDefault();
			controller.flyoutIndex = step(controller.flyoutIndex, controller.kinds.length);
		} else if (controller.flyout && key === 'Enter') {
			event.preventDefault();
			const kind = controller.kinds[controller.flyoutIndex];
			if (kind) controller.turnInto(kind);
		} else if (key === 'Delete' && !controller.query) {
			event.preventDefault();
			controller.remove();
		} else if (arrow) {
			event.preventDefault();
			if (count) controller.selectedIndex = step(controller.selectedIndex, count);
			controller.flyout = false;
		} else if ((key === 'Home' || key === 'End') && count) {
			event.preventDefault();
			controller.selectedIndex = key === 'Home' ? 0 : count - 1;
			controller.flyout = false;
		} else if (key === 'ArrowRight' && 'submenu' in (rows[controller.selectedIndex] ?? {})) {
			event.preventDefault();
			controller.openFlyout();
		} else if (key === 'ArrowLeft' && controller.flyout) {
			event.preventDefault();
			controller.flyout = false;
		} else if (key === 'Enter') {
			event.preventDefault();
			controller.runSelected();
		}
	};
</script>

{#if controller.isOpen && menu}
	{@render menu(controller)}
{:else if controller.isOpen}
	<div class="block-menu-frame" bind:this={frame}>
		<div class="block-menu" data-testid="block-menu" data-edytor-block-menu tabindex="-1">
			<div class="block-menu-search">
				<input
					placeholder={labels.search}
					aria-label={labels.searchLabel}
					aria-controls={controller.flyout ? controller.flyoutId : controller.menuId}
					aria-activedescendant={active}
					value={controller.query}
					use:focusOnMount
					oninput={(event) => {
						controller.query = event.currentTarget.value;
						controller.selectedIndex = 0;
						controller.flyout = false;
					}}
					{onkeydown}
				/>
			</div>
			<div class="block-menu-rows" id={controller.menuId} role="menu" aria-label={labels.menu}>
				{#if !controller.query}
					<div class="block-menu-heading" role="presentation">
						{controller.currentKind?.label ?? labels.block}
					</div>
				{/if}
				{#each rows as row, index ('value' in row ? `kind:${row.id}` : row.id)}
					{#if 'value' in row}
						{#if index === 0 || !('value' in rows[index - 1]!)}
							<div class="block-menu-heading" role="presentation">{labels.turnInto}</div>
						{/if}
						<button
							type="button"
							role="menuitem"
							id={controller.rowId(row)}
							tabindex="-1"
							class="block-menu-row"
							data-selected={index === controller.selectedIndex}
							use:keepInView={index === controller.selectedIndex}
							style:--block-menu-icon={iconOf(row.id)}
							onmousedown={(event) => event.preventDefault()}
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
							role="menuitem"
							id={controller.rowId(row)}
							tabindex="-1"
							class="block-menu-row"
							class:danger={row.danger}
							data-selected={index === controller.selectedIndex}
							use:keepInView={index === controller.selectedIndex}
							data-hint={row.submenu ? undefined : row.hint}
							data-submenu={row.submenu ? 'true' : undefined}
							data-testid={`block-menu-${row.id}`}
							style:--block-menu-icon={iconOf(row.icon)}
							aria-haspopup={row.submenu ? 'menu' : undefined}
							aria-expanded={row.submenu ? controller.flyout : undefined}
							onmousedown={(event) => event.preventDefault()}
							onmouseenter={() => {
								controller.selectedIndex = index;
								if (row.submenu) controller.openFlyout();
								else controller.flyout = false;
							}}
							onclick={() => (row.submenu ? controller.openFlyout() : row.run?.())}
							>{row.label}</button
						>
					{/if}
				{/each}
				{#if rows.length === 0}
					<div class="block-menu-empty" role="presentation">{labels.noResults}</div>
				{/if}
			</div>
		</div>
		{#if controller.flyout}
			<div
				class="block-menu block-menu-flyout"
				id={controller.flyoutId}
				role="menu"
				aria-label={labels.turnInto}
				data-edytor-block-menu-flyout
			>
				<div class="block-menu-rows" role="presentation">
					<div class="block-menu-heading" role="presentation">{labels.turnInto}</div>
					{#each controller.kinds as kind, index (kind.id)}
						<button
							type="button"
							role="menuitem"
							id={controller.rowId(kind, true)}
							tabindex="-1"
							class="block-menu-row"
							data-current={kind === controller.currentKind}
							data-selected={controller.flyoutIndex === index}
							use:keepInView={controller.flyoutIndex === index}
							onmousemove={() => (controller.flyoutIndex = index)}
							style:--block-menu-icon={iconOf(kind.id)}
							onmousedown={(event) => event.preventDefault()}
							onclick={() => controller.turnInto(kind)}>{kind.label}</button
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
