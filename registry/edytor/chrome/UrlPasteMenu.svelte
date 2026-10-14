<script lang="ts">
	import { float } from './float.js';
	import { Button } from '$registry/ui/button/index.js';
	import { words } from './words.svelte.js';
	import type { UrlPasteController } from 'edytor';

	/** The menu a URL pasted on an empty line opens, drawn for an embed or bookmark plugin's `menu`. */
	let { controller }: { controller: UrlPasteController } = $props();
</script>

<!--
	The editor keeps the keyboard: its keys move and pick (the plugin's
	hotkeys). The listbox's id, role and publication to the view's root are
	the controller's `popup` attachment, a row's ARIA its
	`option(index)`.
-->
<div
	class="url-paste-menu"
	data-edytor-url-paste-menu
	role="listbox"
	aria-label={words.urlPaste.menu}
	tabindex="-1"
	{@attach controller.popup}
	{@attach float(() => controller.anchor, { gap: 4 })}
>
	{#each controller.open?.options ?? [] as option, index (option.id)}
		<Button
			variant="ghost"
			class="url-paste-option"
			data-selected={controller.index === index}
			{@attach controller.option(index)}
			data-edytor-url-paste-option={option.id}
			onmousemove={() => (controller.index = index)}
			onclick={() => controller.pick(option)}
			><span aria-hidden="true">{option.icon}</span>{words.urlPaste[option.id] ?? option.id}</Button
		>
	{/each}
</div>

<style>
	.url-paste-menu {
		display: flex;
		flex-direction: column;
		min-width: 200px;
		padding: 4px;
		border-radius: 10px;
		background: var(--popover);
		color: var(--popover-foreground);
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px var(--border);
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
	.url-paste-menu :global(.url-paste-option) {
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
	.url-paste-menu :global(.url-paste-option span) {
		display: grid;
		place-items: center;
		width: 20px;
	}
	.url-paste-menu :global(.url-paste-option[data-selected='true']) {
		background: var(--border);
	}
</style>
