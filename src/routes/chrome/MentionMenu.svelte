<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { MentionItem, TriggerMenuController } from '$lib/index.js';

	/** Notion's `@` menu, drawn for `createMentionPlugin({ menu })`: a person's avatar, name and line. */
	let { controller }: { controller: TriggerMenuController<MentionItem> } = $props();

	/** An avatar's URL when it is one an `img` may load (http, https, a data image), else nothing. */
	const avatarOf = (src: unknown) =>
		typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim()) ? src : undefined;
</script>

<TriggerMenu {controller} said={words.mention}>
	{#snippet row(item: MentionItem, index: number)}
		<button
			type="button"
			class="row"
			{...controller.option(index)}
			data-testid="trigger-menu-item"
			onmousemove={() => (controller.selectedIndex = index)}
			onclick={() => void controller.pick(item)}
		>
			<span class="avatar" aria-hidden="true">
				{#if avatarOf(item.avatar)}
					<img src={avatarOf(item.avatar)} alt="" />
				{:else}
					{item.label.trim().charAt(0).toUpperCase()}
				{/if}
			</span>
			<span class="name">{item.label}</span>
			{#if item.description}<span class="description">{item.description}</span>{/if}
		</button>
	{/snippet}
</TriggerMenu>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 32px;
		padding: 4px 8px;
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
	.avatar {
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		overflow: hidden;
		border-radius: 50%;
		background: rgba(84, 72, 49, 0.12);
		font-size: 11px;
		font-weight: 600;
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.description {
		margin-left: auto;
		overflow: hidden;
		color: #73726e;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
