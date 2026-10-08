<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import { richTextLabels } from './labels.js';
	import { DEFAULT_CALLOUT_ICON, calloutIconViews, iconOf } from './calloutIcons.svelte.js';

	/**
	 * A callout's icon (`callout.icon`): its `data.icon`, the view's default
	 * without one, none when it is `''`. In an editable view it is a button
	 * (a kind's own control) opening the view's picker, named Change icon, or
	 * Add icon over an empty slot; a readonly view, or a suggestion's preview,
	 * shows the icon alone.
	 */
	let { block }: { block: BlockView<{ icon?: string }> } = $props();
	const edytor = getContext<Edytor>('edytor');
	const labels = richTextLabels.of(edytor).calloutIcon;
	const picker = calloutIconViews.get(edytor);
	const icon = $derived(iconOf(block.data, picker?.icon ?? DEFAULT_CALLOUT_ICON));
	const open = $derived(picker?.target === block.id);
</script>

{#if block.handle && picker && !edytor.readonly}
	<button
		type="button"
		contenteditable="false"
		data-edytor-callout-icon
		data-empty={icon ? undefined : ''}
		aria-label={icon ? labels.change : labels.add}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={open ? picker.id : undefined}
		onmousedown={(event) => event.preventDefault()}
		onclick={() => block.handle && picker.toggle(block.handle)}>{icon}</button
	>
{:else if icon}
	<span contenteditable="false" data-edytor-callout-icon aria-hidden="true">{icon}</span>
{/if}
