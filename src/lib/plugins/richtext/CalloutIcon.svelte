<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import { calloutIcon } from './controls.svelte.js';

	/**
	 * A callout's icon (`callout.icon`, the default; an app's `calloutIcon`
	 * snippet replaces it, `RichTextControl`): in an editable view a button
	 * (a kind's own control) opening the view's picker, named Change icon,
	 * or Add icon over an empty slot; a readonly view, or a suggestion's
	 * preview, shows the icon alone.
	 */
	let { block }: { block: BlockView<{ icon?: string }> } = $props();
	const icon = calloutIcon(getContext<Edytor>('edytor'), () => block);
</script>

{#if icon.editable}
	<button type="button" {@attach icon.control}>{icon.icon}</button>
{:else if icon.icon}
	<!-- A server render (a readonly view's) shows this one: its marker is written here too. -->
	<span data-edytor-callout-icon contenteditable="false" aria-hidden="true" {@attach icon.control}
		>{icon.icon}</span
	>
{/if}
