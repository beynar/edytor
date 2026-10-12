<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { PageLinkItem, TriggerMenuController } from '$lib/index.js';

	/** Notion's `[[` menu, drawn for `createPageLinkPlugin({ menu })`: a page's icon and title. */
	let { controller }: { controller: TriggerMenuController<PageLinkItem> } = $props();
</script>

<TriggerMenu {controller} said={words.pageLink}>
	{#snippet row(item: PageLinkItem, index: number)}
		<button
			type="button"
			class="row"
			{...controller.option(index)}
			data-testid="trigger-menu-item"
			onmousemove={() => (controller.index = index)}
			onclick={() => void controller.pick(item)}
		>
			<span aria-hidden="true">{item.icon ?? '📄'}</span>
			<span class="title">{item.title}</span>
		</button>
	{/snippet}
</TriggerMenu>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.row[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
