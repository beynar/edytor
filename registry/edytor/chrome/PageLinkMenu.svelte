<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { PageLinkItem, TriggerMenuController } from 'edytor';
	import { Button } from '$registry/ui/button/index.js';
	import { cn } from '$registry/utils.js';
	import { row as rowClass } from './ui.js';

	/** Notion's `[[` menu, drawn for `createPageLinkPlugin({ menu })`: a page's icon and title. */
	let { controller }: { controller: TriggerMenuController<PageLinkItem> } = $props();
</script>

<TriggerMenu {controller} said={words.pageLink}>
	{#snippet row(item: PageLinkItem, index: number)}
		<Button
			variant="ghost"
			class={cn(rowClass, 'row')}
			data-selected={controller.index === index}
			{@attach controller.option(index)}
			data-testid="trigger-menu-item"
			onmousemove={() => (controller.index = index)}
			onclick={() => void controller.pick(item)}
		>
			<span aria-hidden="true">{item.icon ?? '📄'}</span>
			<span class="title truncate">{item.title}</span>
		</Button>
	{/snippet}
</TriggerMenu>
