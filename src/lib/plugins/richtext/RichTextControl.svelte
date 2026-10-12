<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import TodoCheckbox from './TodoCheckbox.svelte';
	import CalloutIcon from './CalloutIcon.svelte';
	import EmptyBody from './EmptyBody.svelte';
	import { calloutIcon, emptyBody, richTextControls, todoCheckbox } from './controls.svelte.js';

	/**
	 * A rich text control of a kind whose markup the app replaces (the
	 * kind's record draws this only then, so the default markup costs no
	 * branch): the app's snippet of the view rendering it, else the default.
	 * `control` is the checkbox, the callout's icon, or a toggle's or a
	 * callout's empty body.
	 */
	let {
		block,
		control
	}: { block: BlockView<any>; control: 'checkbox' | 'calloutIcon' | 'toggle' | 'callout' } =
		$props();
	const view = getContext<Edytor>('edytor');
	const own = richTextControls.get(view) ?? {};
</script>

{#if control === 'checkbox'}
	{@const box = todoCheckbox(view, () => block)}
	{#if own.checkbox}{@render own.checkbox(box)}{:else}<TodoCheckbox {block} />{/if}
{:else if control === 'calloutIcon'}
	{@const icon = calloutIcon(view, () => block)}
	{#if !own.calloutIcon}<CalloutIcon
			{block}
		/>{:else if icon.editable || icon.icon}{@render own.calloutIcon(icon)}{/if}
{:else}
	{@const hint = emptyBody(view, block, control)}
	{#if !own.emptyBody}<EmptyBody {block} kind={control} />{:else if hint}{@render own.emptyBody(
			hint
		)}{/if}
{/if}
