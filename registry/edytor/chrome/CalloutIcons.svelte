<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { words } from './words.svelte.js';
	import type { CalloutIconPicker } from 'edytor';

	/**
	 * Notion's callout icon picker, drawn for `createRichTextPlugin({ callout:
	 * { picker } })`: a grid of the view's icons, then Remove icon.
	 */
	let { picker }: { picker: CalloutIconPicker } = $props();
</script>

<div
	class="callout-icons"
	aria-label={words.calloutIcons.picker}
	{@attach picker.keys}
	{@attach picker.popup}
>
	<div class="callout-icons-grid" role="none" style:--callout-icon-columns={picker.columns}>
		{#each picker.icons as icon, index (index)}
			<Button
				variant="ghost"
				data-edytor-callout-icon-choice
				data-selected={picker.index === index}
				data-current={icon === picker.current}
				{@attach picker.option(index)}
				onmouseenter={() => (picker.index = index)}
				onclick={() => picker.pick(index)}>{icon}</Button
			>
		{/each}
	</div>
	<Button
		variant="ghost"
		class="callout-icons-remove"
		data-edytor-callout-icon-remove
		data-selected={picker.index === picker.icons.length}
		{@attach picker.option(picker.icons.length)}
		onmouseenter={() => (picker.index = picker.icons.length)}
		onclick={() => picker.pick(picker.icons.length)}>{words.calloutIcons.remove}</Button
	>
</div>

<style>
	.callout-icons {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
		border-radius: 10px;
		background: var(--popover);
		color: var(--popover-foreground);
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px var(--border);
		font-family:
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
		font-size: 14px;
		line-height: 20px;
		outline: 0;
	}
	.callout-icons-grid {
		display: grid;
		grid-template-columns: repeat(var(--callout-icon-columns), 32px);
		gap: 2px;
	}
	.callout-icons :global(button) {
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.callout-icons-grid :global(button) {
		width: 32px;
		height: 32px;
		padding: 0;
		font-size: 20px;
		line-height: 32px;
	}
	.callout-icons :global(button[data-selected='true']) {
		background: var(--accent);
	}
	.callout-icons :global(button[data-current='true']) {
		box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--ring) 57%, transparent);
	}
	.callout-icons :global(.callout-icons-remove) {
		padding: 4px 8px;
		text-align: start;
		color: var(--muted-foreground);
	}
</style>
