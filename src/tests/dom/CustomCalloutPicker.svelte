<script module lang="ts">
	import type { CalloutIconPicker } from '$lib/plugins/index.js';

	/** An app's own callout icon picker: the controller's attachments and rows, its own markup. */
	export { customPicker };
</script>

{#snippet customPicker(picker: CalloutIconPicker)}
	<div data-testid="custom-picker" {@attach picker.keys} {@attach picker.popup}>
		<p data-testid="custom-picker-current">{picker.current}</p>
		{#each picker.icons as icon, index (index)}
			<button type="button" data-testid="custom-icon" {...picker.option(index)}>{icon}</button>
		{/each}
		<button type="button" data-testid="custom-remove" {...picker.option(picker.icons.length)}
			>{picker.labels.remove}</button
		>
		<button type="button" data-testid="custom-close" onclick={() => picker.close()}>×</button>
	</div>
{/snippet}
