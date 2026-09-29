<script lang="ts">
	import { iconOf } from '../icons.js';
	import type { SlashMenuController } from './SlashMenuController.svelte.js';

	let { controller }: { controller: SlashMenuController } = $props();
	const commands = $derived(controller.commands);

	/** Keep the keyboard's row in view. */
	const selected = (node: HTMLElement, isSelected: boolean) => {
		const reveal = (value: boolean) => value && node.scrollIntoView?.({ block: 'nearest' });
		reveal(isSelected);
		return { update: reveal };
	};
</script>

{#if controller.isOpen}
	<div class="slash-menu" data-testid="slash-menu" role="listbox" aria-label="Block commands">
		<div class="slash-query" data-testid="slash-menu-query" aria-live="polite">
			/{controller.query}
		</div>
		<div class="slash-items">
			{#if commands.length === 0}
				<div class="slash-empty" data-testid="slash-menu-empty">No results</div>
			{/if}
			{#each commands as command, index (command.id)}
				{#if index === 0 || command.group !== commands[index - 1]?.group}
					{#if command.group}<div class="slash-heading">{command.group}</div>{/if}
				{/if}
				<button
					type="button"
					class="slash-item"
					data-command-id={command.id}
					data-icon={command.icon ?? '⋮'}
					data-glyph={iconOf(command.id) ? undefined : (command.icon ?? '⋮')}
					data-hint={command.hint}
					style:--slash-icon={iconOf(command.id)}
					data-selected={index === controller.selectedIndex}
					data-testid="slash-menu-item"
					role="option"
					aria-selected={index === controller.selectedIndex}
					use:selected={index === controller.selectedIndex}
					onmousedown={(event) => event.preventDefault()}
					onmousemove={() => (controller.selectedIndex = index)}
					onclick={() => {
						void controller.run(command);
					}}>{command.label}</button
				>
			{/each}
		</div>
		<button
			type="button"
			class="slash-footer"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.close()}><span>Close menu</span><kbd>esc</kbd></button
		>
	</div>
{/if}

<style>
	.slash-menu {
		width: 324px;
		max-height: min(40vh, 380px);
		min-height: 120px;
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
		transform-origin: top left;
		animation: slash-in 140ms cubic-bezier(0.2, 0, 0, 1);
	}
	@keyframes slash-in {
		from {
			opacity: 0;
			transform: translateY(-4px) scale(0.98);
		}
	}
	.slash-query {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.slash-items {
		flex: 1;
		overflow-y: auto;
		padding: 4px;
	}
	.slash-heading {
		padding: 8px 8px 4px;
		color: #7d7a75;
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
		user-select: none;
	}
	.slash-item {
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
	.slash-item::before {
		content: attr(data-glyph);
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		color: #383836;
		font-size: 13px;
		font-weight: 600;
		line-height: 1;
	}
	.slash-item[style*='--slash-icon']::before {
		content: '';
		background: currentColor;
		-webkit-mask: var(--slash-icon) center / 20px no-repeat;
		mask: var(--slash-icon) center / 20px no-repeat;
	}
	.slash-item[data-hint]::after {
		content: attr(data-hint);
		margin-left: auto;
		color: #a19e99;
		font-size: 12px;
	}
	.slash-item[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.slash-empty {
		padding: 6px 8px;
		color: #7d7a75;
	}
	.slash-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		height: 36px;
		padding: 0 12px;
		border-top: 1px solid rgba(28, 19, 1, 0.08);
		color: #7d7a75;
		font: inherit;
		cursor: pointer;
	}
	.slash-footer:hover {
		background: rgba(33, 27, 23, 0.04);
	}
	.slash-footer kbd {
		color: #a19e99;
		font: inherit;
		font-size: 12px;
	}
</style>
