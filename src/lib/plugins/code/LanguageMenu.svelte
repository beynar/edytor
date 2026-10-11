<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LanguageMenu } from './languageMenu.svelte.js';

	/**
	 * The code language list (`LanguageMenu`), in the overlay under the
	 * language button of its block: the plugin's `menu` snippet, placed. Its
	 * keys and ARIA are the controller's attachments (`keys`, `popup`,
	 * `option(index)`).
	 */
	let { menu, snippet }: { menu: LanguageMenu; snippet: Snippet<[LanguageMenu]> } = $props();

	const place = $derived(menu.open && menu.panel.place(4));
</script>

{#if place}
	<div
		data-edytor-code-language-panel
		style:position="absolute"
		style:left="{place.left}px"
		style:top="{place.top}px"
	>
		{@render snippet(menu)}
	</div>
{/if}
