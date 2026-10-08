<script lang="ts">
	import { iconOf } from '../icons.js';
	import type { Snippet } from 'svelte';
	import type { SlashMenuController } from './SlashMenuController.svelte.js';
	import type { SlashMenuItem } from './slashMenuPlugin.js';
	import type { EditorCommand } from '$lib/plugins.js';

	let {
		controller,
		menu,
		item
	}: {
		controller: SlashMenuController;
		menu?: Snippet<[SlashMenuController]>;
		item?: Snippet<[SlashMenuItem]>;
	} = $props();
	const commands = $derived(controller.commands);
	const labels = $derived(controller.labels);
	// An editor turning readonly closes the menu (its commands would be refused).
	$effect(() => {
		if (controller.isOpen && controller.readonly) controller.dismiss(false);
	});

	/** A press in the menu keeps the focus where it is (its field, or the editor's caret). */
	const keepFocus = (event: MouseEvent) => {
		if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
	};
	/** The rows by group, in order (Notion's headings): a `group` per run of one group's rows. */
	const groups = $derived.by(() => {
		const runs: { name: string; rows: { command: EditorCommand; index: number }[] }[] = [];
		commands.forEach((command, index) => {
			const name = command.group ?? '';
			const run = runs.at(-1);
			if (run && run.name === name) run.rows.push({ command, index });
			else runs.push({ name, rows: [{ command, index }] });
		});
		return runs;
	});

	/** The row payload of an `item` snippet. */
	const payload = (command: EditorCommand, index: number): SlashMenuItem => {
		const run = () => void controller.run(command);
		return {
			item: command,
			command,
			id: controller.optionId(command),
			label: command.label,
			selected: index === controller.selectedIndex,
			icon: iconOf(command.id),
			run,
			select: () => (controller.selectedIndex = index),
			option: controller.option(index)
		};
	};
</script>

<!--
	The keys of a `+`'s menu (`keys`), the listbox's id, role and publication
	to the view's root (`popup`) and a row's attributes (`option(index)`) are
	the controller's: a custom `menu` or `item` that uses them behaves as
	this one.
-->
{#if controller.isOpen && menu && controller.addition}
	<!-- The `+`'s menu takes the keyboard from the editor: typing filters it, never the document. -->
	<div class="slash-keys" tabindex="-1" role="presentation" {@attach controller.keys}>
		{@render menu(controller)}
	</div>
{:else if controller.isOpen && menu}
	{@render menu(controller)}
{:else if controller.isOpen}
	<div
		class="slash-menu"
		data-testid="slash-menu"
		tabindex="-1"
		role="presentation"
		onmousedown={keepFocus}
	>
		{#if controller.addition}
			<input
				class="slash-search"
				placeholder={labels.filter}
				aria-label={labels.filterLabel}
				role="combobox"
				aria-expanded="true"
				aria-autocomplete="list"
				aria-controls={controller.listId}
				value={controller.query}
				{@attach controller.keys}
				oninput={(event) => controller.search(event.currentTarget.value)}
			/>
		{:else}
			<div class="slash-query" data-testid="slash-menu-query" aria-live="polite">
				/{controller.query}
			</div>
		{/if}
		<div class="slash-items" role="listbox" aria-label={labels.list} {@attach controller.popup}>
			{#if commands.length === 0}
				<div class="slash-empty" data-testid="slash-menu-empty">{labels.noResults}</div>
			{/if}
			{#each groups as group, at (`${at}:${group.name}`)}
				<div role="group" aria-label={group.name ? controller.groupName(group.name) : undefined}>
					{#if group.name}<div class="slash-heading" aria-hidden="true">
							{controller.groupName(group.name)}
						</div>{/if}
					{#each group.rows as { command, index } (command.id)}
						{#if item}
							{@render item(payload(command, index))}
						{:else}
							<button
								type="button"
								class="slash-item"
								{...controller.option(index)}
								data-command-id={command.id}
								data-icon={command.icon ?? '⋮'}
								data-glyph={iconOf(command.id) ? undefined : (command.icon ?? '⋮')}
								data-hint={command.hint}
								style:--slash-icon={iconOf(command.id)}
								data-testid="slash-menu-item"
								onmousemove={() => (controller.selectedIndex = index)}
								onclick={() => {
									void controller.run(command);
								}}>{command.label}</button
							>
						{/if}
					{/each}
				</div>
			{/each}
		</div>
		<button
			type="button"
			class="slash-footer"
			tabindex="-1"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.dismiss()}
			><span>{labels.close}</span><kbd>{labels.closeKey}</kbd></button
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
	.slash-keys {
		outline: none;
	}
	.slash-search {
		margin: 8px 8px 0;
		padding: 4px 8px;
		border-radius: 6px;
		border: 1px solid rgba(28, 19, 1, 0.12);
		background: transparent;
		color: inherit;
		font: inherit;
		outline: none;
	}
	.slash-items {
		flex: 1;
		overflow-y: auto;
		padding: 4px;
	}
	.slash-heading {
		padding: 8px 8px 4px;
		color: #73726e;
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
		color: #73726e;
		font-size: 12px;
	}
	.slash-item[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.slash-empty {
		padding: 6px 8px;
		color: #73726e;
	}
	.slash-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		height: 36px;
		padding: 0 12px;
		border-top: 1px solid rgba(28, 19, 1, 0.08);
		color: #73726e;
		font: inherit;
		cursor: pointer;
	}
	.slash-footer:hover {
		background: rgba(33, 27, 23, 0.04);
	}
	.slash-footer kbd {
		padding: 0;
		background: none;
		color: #73726e;
		font: inherit;
		font-size: 12px;
	}
</style>
