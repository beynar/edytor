<script lang="ts">
	import { iconOf } from '../icons.js';
	import { keepInView } from '../keepInView.js';
	import type { Snippet } from 'svelte';
	import type { SlashMenuController } from './SlashMenuController.svelte.js';
	import type { SlashMenuItem } from './slashMenuPlugin.js';

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
	// An editor turning readonly closes the menu (its commands would be refused).
	$effect(() => {
		if (controller.isOpen && controller.readonly) controller.dismiss(false);
	});

	/** A `+`'s menu holds the keyboard: its keys are the editor's slash keys. */
	const onkeydown = (event: KeyboardEvent) => {
		// A key that ends an IME composition (Enter commits it, Escape cancels it) is the IME's.
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
		const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (move) controller.moveSelection(move);
		else if (event.key === 'Enter') void controller.runSelected();
		else if (event.key === 'Escape') controller.dismiss();
		else return;
		event.preventDefault();
	};
	/** Keys on a `menu` snippet with no field of its own: typing is the query. */
	const typing = (event: KeyboardEvent) => {
		const { key, ctrlKey, metaKey, target, currentTarget } = event;
		if (target !== currentTarget || event.defaultPrevented) return onkeydown(event);
		if (key === 'Backspace') controller.search(controller.query.slice(0, -1));
		else if (key.length === 1 && !ctrlKey && !metaKey) controller.search(controller.query + key);
		else return onkeydown(event);
		event.preventDefault();
	};
	/** Focus leaving the `+`'s menu (Tab, another field) closes it. */
	const onfocusout = (event: FocusEvent) => {
		const to = event.relatedTarget;
		const menu = event.currentTarget as HTMLElement;
		if (controller.addition && to instanceof Node && !menu.contains(to)) controller.dismiss(false);
	};
	/**
	 * The `+`'s field is the menu's one keyboard owner: a row or the footer
	 * that takes focus (a click, a screen reader) hands it back, a row
	 * becoming the highlighted one, so the keys and the highlight stay in step.
	 */
	let field = $state<HTMLInputElement>();
	const onfocusin = (event: FocusEvent) => {
		if (!field || event.target === field) return;
		const index = commands.findIndex(
			(command) => command.id === (event.target as HTMLElement).dataset.commandId
		);
		if (index !== -1) controller.selectedIndex = index;
		field.focus({ preventScroll: true });
	};
	/** A press in the menu keeps the focus where it is (its field, or the editor's caret). */
	const keepFocus = (event: MouseEvent) => {
		if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
	};
	const focusOnMount = (node: HTMLElement) => {
		if (!node.contains(node.ownerDocument.activeElement)) node.focus({ preventScroll: true });
	};
</script>

{#if controller.isOpen && menu && controller.addition}
	<!-- The `+`'s menu takes the keyboard from the editor: typing filters it, never the document. -->
	<div
		class="slash-keys"
		tabindex="-1"
		role="presentation"
		use:focusOnMount
		onkeydown={typing}
		{onfocusout}
	>
		{@render menu(controller)}
	</div>
{:else if controller.isOpen && menu}
	{@render menu(controller)}
{:else if controller.isOpen}
	<div
		class="slash-menu"
		data-testid="slash-menu"
		role="listbox"
		aria-label="Block commands"
		tabindex="-1"
		onmousedown={keepFocus}
		onkeydown={controller.addition ? onkeydown : undefined}
		onfocusin={controller.addition ? onfocusin : undefined}
		{onfocusout}
	>
		{#if controller.addition}
			<input
				bind:this={field}
				class="slash-search"
				placeholder="Type to filter…"
				aria-label="Filter block commands"
				value={controller.query}
				use:focusOnMount
				oninput={(event) => controller.search(event.currentTarget.value)}
			/>
		{:else}
			<div class="slash-query" data-testid="slash-menu-query" aria-live="polite">
				/{controller.query}
			</div>
		{/if}
		<div class="slash-items">
			{#if commands.length === 0}
				<div class="slash-empty" data-testid="slash-menu-empty">No results</div>
			{/if}
			{#each commands as command, index (command.id)}
				{#if index === 0 || command.group !== commands[index - 1]?.group}
					{#if command.group}<div class="slash-heading">{command.group}</div>{/if}
				{/if}
				{#if item}
					{@render item({
						command,
						selected: index === controller.selectedIndex,
						icon: iconOf(command.id),
						run: () => void controller.run(command),
						select: () => (controller.selectedIndex = index)
					})}
				{:else}
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
						tabindex="-1"
						aria-selected={index === controller.selectedIndex}
						use:keepInView={index === controller.selectedIndex}
						onmousedown={(event) => event.preventDefault()}
						onmousemove={() => (controller.selectedIndex = index)}
						onclick={() => {
							void controller.run(command);
						}}>{command.label}</button
					>
				{/if}
			{/each}
		</div>
		<button
			type="button"
			class="slash-footer"
			tabindex="-1"
			onmousedown={(event) => event.preventDefault()}
			onclick={() => controller.dismiss()}><span>Close menu</span><kbd>esc</kbd></button
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
