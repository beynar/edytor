<script module lang="ts">
	import type { CalloutIconPicker } from '$lib/plugins/index.js';

	/** An app's own callout icon picker: the controller's attachments and rows, its own markup. */
	export { customPicker };
</script>

{#snippet customPicker(picker: CalloutIconPicker)}
	<div data-testid="custom-picker" {@attach picker.keys} {@attach picker.popup}>
		<p data-testid="custom-picker-current">{picker.current}</p>
		{#each picker.icons as icon, index (index)}
			<button
				type="button"
				data-testid="custom-icon"
				{@attach picker.option(index)}
				onclick={() => picker.pick(index)}>{icon}</button
			>
		{/each}
		<button
			type="button"
			data-testid="custom-remove"
			{@attach picker.option(picker.icons.length)}
			onclick={() => picker.pick(picker.icons.length)}>Remove icon</button
		>
		<button type="button" data-testid="custom-close" onclick={() => picker.close()}>×</button>
	</div>
{/snippet}
