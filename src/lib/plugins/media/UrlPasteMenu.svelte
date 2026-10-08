<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { UrlPasteController } from './urlPaste.svelte.js';

	let {
		controller,
		menu
	}: { controller: UrlPasteController; menu?: Snippet<[UrlPasteController]> } = $props();
	// An editor turning readonly closes the menu (its conversions would be refused).
	$effect(() => {
		if (controller.open && controller.readonly) controller.close();
	});
</script>

<!--
	The editor keeps the keyboard: its keys move and pick (the plugin's
	hotkeys). The listbox's id, role and publication to the view's root are
	the controller's `popup` attachment, a row's attributes its
	`option(index)`: a custom `menu` that uses them behaves as this one.
-->
{#if controller.open && menu}
	{@render menu(controller)}
{:else if controller.open}
	<div
		class="url-paste-menu"
		data-edytor-url-paste-menu
		role="listbox"
		aria-label={controller.labels.pasteAs}
		tabindex="-1"
		{@attach controller.popup}
	>
		{#each controller.open.options as option, index (option.id)}
			<button
				type="button"
				class="url-paste-option"
				{...controller.option(index)}
				data-edytor-url-paste-option={option.id}
				onmousemove={() => (controller.index = index)}
				onclick={() => controller.pick(option)}
				><span aria-hidden="true">{option.icon}</span>{option.label}</button
			>
		{/each}
	</div>
{/if}

<style>
	.url-paste-menu {
		display: flex;
		flex-direction: column;
		min-width: 200px;
		padding: 4px;
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
	}
	.url-paste-option {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 28px;
		padding: 0 8px;
		border-radius: 6px;
		color: inherit;
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}
	.url-paste-option span {
		display: grid;
		place-items: center;
		width: 20px;
	}
	.url-paste-option[aria-selected='true'] {
		background: rgba(84, 72, 49, 0.08);
	}
</style>
