<script lang="ts">
	import type { TriggerItemPayload } from '$lib/plugins.js';
	import type { TriggerMenuController } from './TriggerController.svelte.js';

	let { controller }: { controller: TriggerMenuController<any> } = $props();
	const items = $derived(controller.items);
	const row = $derived(controller.trigger.item);
	const menu = $derived(controller.trigger.menu);

	// An editor turning readonly closes the menu (a pick would be refused).
	$effect(() => {
		if (controller.isOpen && controller.readonly) controller.close();
	});

	/** The row payload of an `item` snippet. */
	const payload = (item: unknown, index: number): TriggerItemPayload<unknown> => {
		const pick = () => void controller.pick(item);
		return {
			item,
			label: controller.labelOf(item),
			id: controller.optionId(index),
			selected: index === controller.selectedIndex,
			run: pick,
			pick,
			select: () => (controller.selectedIndex = index),
			option: controller.option(index)
		};
	};
</script>

<!--
	The listbox's id, role and publication to the view's root are the
	controller's `popup` attachment, a row's attributes its `option(index)`:
	a custom `menu` that uses them behaves as this one.
-->
{#if controller.isOpen && menu}
	{@render menu(controller)}
{:else if controller.isOpen}
	<!-- A press in the menu keeps the editor's focus and its caret at the query. -->
	<div
		class="edytor-trigger-menu"
		data-testid="trigger-menu"
		data-trigger={controller.char}
		role="presentation"
		onmousedown={(event) => event.preventDefault()}
	>
		<div
			class="edytor-trigger-items"
			role="listbox"
			aria-label={controller.name}
			aria-busy={controller.loading}
			{@attach controller.popup}
		>
			<!-- Keyed by position and key: two rows may share a key (a label without an id). -->
			{#each items as item, index (`${index}:${controller.keyOf(item)}`)}
				{#if row}
					{@render row(payload(item, index))}
				{:else}
					<button
						type="button"
						class="edytor-trigger-item"
						{...controller.option(index)}
						data-testid="trigger-menu-item"
						onmousemove={() => (controller.selectedIndex = index)}
						onclick={() => void controller.pick(item)}
					>
						{controller.labelOf(item)}
					</button>
				{/if}
			{/each}
			{#if items.length === 0}
				<div class="edytor-trigger-empty" data-testid="trigger-menu-empty">
					{controller.loading ? controller.searching : controller.empty}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.edytor-trigger-menu {
		width: 280px;
		max-height: min(40vh, 320px);
		display: flex;
		flex-direction: column;
		border-radius: 10px;
		background: #fff;
		color: #2c2c2b;
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px rgba(84, 72, 49, 0.08);
		font-size: 14px;
		line-height: 20px;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI Variable Display',
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
		overflow: hidden;
	}
	.edytor-trigger-items {
		flex: 1;
		overflow-y: auto;
		padding: 4px;
	}
	.edytor-trigger-item {
		display: block;
		width: 100%;
		height: 28px;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		line-height: 28px;
		text-align: left;
		padding: 0 8px;
		border-radius: 6px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	.edytor-trigger-item[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.edytor-trigger-empty {
		padding: 6px 8px;
		color: #73726e;
	}
</style>
