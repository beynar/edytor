<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ICON_COLUMNS, type CalloutIconPicker } from './calloutIcons.svelte.js';

	/**
	 * A callout's icon picker (`callout.icon`), in the overlay under the icon:
	 * the app's `picker` snippet, else a menu of the view's icons, then Remove
	 * icon. Both take the keys and publish the popup through the controller's
	 * attachments (`keys`, `popup`) and rows (`option`).
	 */
	let { picker, menu }: { picker: CalloutIconPicker; menu?: Snippet<[CalloutIconPicker]> } =
		$props();

	// A view turning readonly closes it (its write would be refused).
	$effect(() => {
		if (picker.isOpen && picker.readonly) picker.close(false);
	});
</script>

{#if picker.isOpen}
	<div data-edytor-callout-icons style:opacity={picker.box ? undefined : 0}>
		{#if menu}
			{@render menu(picker)}
		{:else}
			<div class="callout-icons" {@attach picker.keys} {@attach picker.popup}>
				<div class="callout-icons-grid" role="none" style:--callout-icon-columns={ICON_COLUMNS}>
					{#each picker.icons as icon, index (index)}
						<button type="button" tabindex="-1" {...picker.option(index)}>{icon}</button>
					{/each}
				</div>
				<button
					type="button"
					class="callout-icons-remove"
					tabindex="-1"
					{...picker.option(picker.icons.length)}>{picker.labels.remove}</button
				>
			</div>
		{/if}
	</div>
{/if}

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
	.callout-icons button[data-active] {
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
