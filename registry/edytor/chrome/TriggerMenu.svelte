<script lang="ts" generics="T">
	import { words } from './words.svelte.js';
	import type { Snippet } from 'svelte';
	import type { TriggerMenuController } from 'edytor';
	import { Button } from '$registry/ui/button/index.js';
	import { cn } from '$registry/utils.js';
	import { row as rowClass, surface } from './ui.js';

	/**
	 * A trigger's menu (`@`, `[[`, a plugin's own), drawn for a trigger's
	 * `menu`: its rows are `row`'s (the item and its index), else the item's
	 * label.
	 */
	let {
		controller,
		row,
		said = words.trigger
	}: {
		controller: TriggerMenuController<T>;
		row?: Snippet<[T, number]>;
		/** The menu's name and its empty and pending texts. */
		said?: { menu: string; searching: string; noResults: string };
	} = $props();
	const items = $derived(controller.items);
</script>

<!--
	The listbox's id, role and publication to the view's root are the
	controller's `popup` attachment, a row's ARIA its `option(index)`.
	A press in the menu keeps the editor's focus and its caret at the query.
-->
<div
	class={cn('edytor-trigger-menu', surface)}
	data-testid="trigger-menu"
	data-trigger={controller.char}
	role="presentation"
	onmousedown={(event) => event.preventDefault()}
>
	<div
		class="edytor-trigger-items"
		role="listbox"
		aria-label={said.menu}
		aria-busy={controller.loading}
		{@attach controller.popup}
	>
		<!-- Keyed by position and key: two rows may share a key (a label without an id). -->
		{#each items as item, index (`${index}:${controller.keyOf(item)}`)}
			{#if row}
				{@render row(item, index)}
			{:else}
				<Button
					variant="ghost"
					class={cn(rowClass, 'edytor-trigger-item block truncate leading-7')}
					data-selected={controller.index === index}
					{@attach controller.option(index)}
					data-testid="trigger-menu-item"
					onmousemove={() => (controller.index = index)}
					onclick={() => void controller.pick(item)}
				>
					{controller.labelOf(item)}
				</Button>
			{/if}
		{/each}
		{#if items.length === 0}
			<div
				class="edytor-trigger-empty text-muted-foreground px-2 py-1.5"
				data-testid="trigger-menu-empty"
			>
				{controller.loading ? said.searching : said.noResults}
			</div>
		{/if}
	</div>
</div>

<style>
	.edytor-trigger-menu {
		width: 280px;
		max-height: min(40vh, 320px);
		display: flex;
		flex-direction: column;
		font-size: 14px;
		line-height: 20px;
		overflow: hidden;
	}
	.edytor-trigger-items {
		flex: 1;
		overflow-y: auto;
		padding: 4px;
	}
</style>
