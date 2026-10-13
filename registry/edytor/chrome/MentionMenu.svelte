<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { MentionItem, TriggerMenuController } from 'edytor';
	import * as Avatar from '$registry/ui/avatar/index.js';
	import { Button } from '$registry/ui/button/index.js';
	import { cn } from '$registry/utils.js';
	import { row as rowClass } from './ui.js';

	/** Notion's `@` menu, drawn for `createMentionPlugin({ menu })`: a person's avatar, name and line. */
	let { controller }: { controller: TriggerMenuController<MentionItem> } = $props();

	/** An avatar's URL when it is one an `img` may load (http, https, a data image), else nothing. */
	const avatarOf = (src: unknown) =>
		typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim()) ? src : undefined;
</script>

<TriggerMenu {controller} said={words.mention}>
	{#snippet row(item: MentionItem, index: number)}
		<Button
			variant="ghost"
			class={cn(rowClass, 'row h-auto min-h-8 py-1')}
			data-selected={controller.index === index}
			{@attach controller.option(index)}
			data-testid="trigger-menu-item"
			data-mention-kind={controller.trigger.name}
			onmousemove={() => (controller.index = index)}
			onclick={() => void controller.pick(item)}
		>
			<Avatar.Root class="avatar size-5 text-[11px] font-semibold" aria-hidden="true">
				{#if avatarOf(item.avatar)}<Avatar.Image src={avatarOf(item.avatar)} alt="" />{/if}
				<Avatar.Fallback>{item.label.trim().charAt(0).toUpperCase()}</Avatar.Fallback>
			</Avatar.Root>
			<span class="name truncate">{item.label}</span>
			{#if item.description}<span class="description text-muted-foreground ml-auto truncate text-xs"
					>{item.description}</span
				>{/if}
		</Button>
	{/snippet}
</TriggerMenu>
