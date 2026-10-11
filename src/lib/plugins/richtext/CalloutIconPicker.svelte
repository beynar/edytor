<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { CalloutIconPicker } from './calloutIcons.svelte.js';

	/**
	 * A callout's icon picker (`callout.icon`), in the overlay under the icon:
	 * the app's `picker` snippet, hidden until its first placement. Its keys
	 * and popup are the controller's attachments (`keys`, `popup`) and rows
	 * (`option`).
	 */
	let { picker, menu }: { picker: CalloutIconPicker; menu: Snippet<[CalloutIconPicker]> } =
		$props();

	// A view turning readonly closes it (its write would be refused).
	$effect(() => {
		if (picker.isOpen && picker.readonly) picker.close(false);
	});
</script>

{#if picker.isOpen}
	<div data-edytor-callout-icons style:opacity={picker.box ? undefined : 0}>
		{@render menu(picker)}
	</div>
{/if}
