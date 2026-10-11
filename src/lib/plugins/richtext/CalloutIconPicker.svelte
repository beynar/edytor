<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { CalloutIconPicker } from './calloutIcons.svelte.js';

	/**
	 * A callout's icon picker (`callout.icon`), in the overlay under the icon:
	 * the app's `picker` snippet, hidden until its first placement (never
	 * `display: none`: it takes the focus as it mounts). Its keys and popup
	 * are the controller's attachments (`keys`, `popup`) and rows (`option`).
	 */
	let { picker, menu }: { picker: CalloutIconPicker; menu: Snippet<[CalloutIconPicker]> } =
		$props();
	const place = $derived(picker.isOpen && picker.panel.place(4));
</script>

{#if picker.isOpen}
	<div
		data-edytor-callout-icons
		style:position="absolute"
		style:left="{place ? place.left : 0}px"
		style:top="{place ? place.top : 0}px"
		style:opacity={place ? undefined : 0}
	>
		{@render menu(picker)}
	</div>
{/if}
