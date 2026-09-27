<script lang="ts">
	import type { SlashMenuController } from './SlashMenuController.svelte.js';

	let { controller }: { controller: SlashMenuController } = $props();
	const commands = $derived(controller.commands);
</script>

{#if controller.isOpen}
	<div class="slash-menu" data-testid="slash-menu" role="listbox" aria-label="Block commands">
		<div class="slash-search">
			<span aria-hidden="true">⌕</span>
			<div data-testid="slash-menu-query">/{controller.query}</div>
		</div>
		<div class="slash-heading">Basic blocks</div>
		{#if commands.length === 0}
			<div class="slash-empty" data-testid="slash-menu-empty">No commands</div>
		{:else}
			<div class="slash-items">
				{#each commands as command, index (command.id)}
					<button
						type="button"
						class="slash-item"
						data-command-id={command.id}
						data-icon={command.icon ?? '⋮'}
						data-selected={index === controller.selectedIndex}
						data-testid="slash-menu-item"
						role="option"
						aria-selected={index === controller.selectedIndex}
						onmousedown={(event) => event.preventDefault()}
						onclick={() => {
							void controller.run(command);
						}}>{command.label}</button
					>
				{/each}
			</div>
		{/if}
		<div class="slash-footer">
			<span>↑↓ navigate</span><span>↵ select</span><span>esc close</span>
		</div>
	</div>
{/if}

<style>
	.slash-menu {
		width: 310px;
		max-height: min(420px, calc(100vh - 20px));
		overflow: hidden;
		display: flex;
		flex-direction: column;
		padding: 4px;
		border-radius: 10px;
		background: #fff;
		color: #37352f;
		box-shadow:
			0 6px 28px #0f0f0f2a,
			0 0 0 1px #0f0f0f12;
		font-size: 14px;
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
	}
	.slash-search {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		color: #787774;
		border-bottom: 1px solid #f0f0ee;
	}
	.slash-search > span {
		font-size: 19px;
		line-height: 1;
	}
	.slash-heading {
		padding: 10px 8px 5px;
		color: #9b9a95;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
	.slash-items {
		overflow-y: auto;
		padding-bottom: 4px;
	}
	.slash-item {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 43px;
		padding: 4px 9px;
		gap: 12px;
		border-radius: 6px;
		text-align: left;
		cursor: pointer;
	}
	.slash-item::before {
		content: attr(data-icon);
		display: grid;
		place-items: center;
		width: 30px;
		min-width: 30px;
		height: 30px;
		border: 1px solid #e8e8e5;
		border-radius: 5px;
		font-size: 15px;
		font-weight: 600;
		color: #55534d;
	}
	.slash-item:hover,
	.slash-item[data-selected='true'] {
		background: #f2f2f0;
	}
	.slash-empty {
		padding: 12px 9px 20px;
		color: #9b9a95;
	}
	.slash-footer {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px 5px;
		border-top: 1px solid #f0f0ee;
		color: #aaa9a5;
		font-size: 11px;
	}
</style>
