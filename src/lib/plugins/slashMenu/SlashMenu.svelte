<script lang="ts">
	import type { SlashMenuController } from './SlashMenuController.svelte.js';

	let { controller }: { controller: SlashMenuController } = $props();

	const commands = $derived(controller.commands);
</script>

{#if controller.isOpen}
	<div
		class="rounded border border-neutral-700 bg-neutral-950 p-1 text-sm text-neutral-50 shadow-lg"
		data-testid="slash-menu"
		role="listbox"
	>
		<div class="px-2 py-1 text-xs text-neutral-400" data-testid="slash-menu-query">
			/{controller.query}
		</div>
		{#if commands.length === 0}
			<div class="px-2 py-1 text-neutral-400" data-testid="slash-menu-empty">No commands</div>
		{:else}
			{#each commands as command, index (command.id)}
				<button
					type="button"
					class="block w-full rounded px-2 py-1 text-left data-[selected=true]:bg-neutral-800"
					data-command-id={command.id}
					data-selected={index === controller.selectedIndex}
					data-testid="slash-menu-item"
					role="option"
					aria-selected={index === controller.selectedIndex}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => {
						void controller.run(command);
					}}
				>
					{command.label}
				</button>
			{/each}
		{/if}
	</div>
{/if}
