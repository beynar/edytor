<script lang="ts">
	import { words } from './words.svelte.js';
	import type { CalloutIconPicker } from '$lib/index.js';

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
			<button
				type="button"
				data-edytor-callout-icon-choice
				{...picker.option(index)}
				onmouseenter={() => (picker.index = index)}
				onclick={() => picker.pick(index)}>{icon}</button
			>
		{/each}
	</div>
	<button
		type="button"
		class="callout-icons-remove"
		data-edytor-callout-icon-remove
		{...picker.option(picker.icons.length)}
		onmouseenter={() => (picker.index = picker.icons.length)}
		onclick={() => picker.pick(picker.icons.length)}>{words.calloutIcons.remove}</button
	>
</div>

<style>
	.callout-icons {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
		border-radius: 10px;
		background: #fff;
		color: #2c2c2b;
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px rgba(84, 72, 49, 0.08);
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
	.callout-icons button {
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.callout-icons-grid button {
		width: 32px;
		height: 32px;
		padding: 0;
		font-size: 20px;
		line-height: 32px;
	}
	.callout-icons button[data-selected='true'] {
		background: rgba(55, 53, 47, 0.08);
	}
	.callout-icons button[aria-checked='true'] {
		box-shadow: inset 0 0 0 2px rgba(35, 131, 226, 0.57);
	}
	.callout-icons-remove {
		padding: 4px 8px;
		text-align: start;
		color: #73726e;
	}
</style>
