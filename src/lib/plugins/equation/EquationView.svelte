<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { equationLabels, equationViews } from './equation.svelte.js';

	/**
	 * An equation as drawn: KaTeX's markup, its source while KaTeX loads (or
	 * with no loader), the source marked invalid when KaTeX cannot read it,
	 * or the placeholder when it is empty. Reads its view's renderer from the
	 * editor it renders in (a suggestion's preview included).
	 */
	let { expression, display }: { expression: string; display: boolean } = $props();

	const edytor = getContext<Edytor | undefined>('edytor');
	const view = $derived(edytor ? equationViews.get(edytor) : undefined);
	const labels = $derived(equationLabels.of(edytor));
	const drawn = $derived(expression ? (view?.renderer.draw(expression, display) ?? null) : null);
</script>

{#if !expression}
	<span data-edytor-equation-placeholder
		><span aria-hidden="true" data-edytor-equation-icon>√x</span>{display
			? labels.blockPlaceholder
			: labels.inlinePlaceholder}</span
	>
{:else if drawn && 'html' in drawn}
	<!-- KaTeX's markup, drawn untrusted (`trust: false`). -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html drawn.html}
{:else if drawn}
	<span data-edytor-equation-error title="{labels.invalid}: {drawn.error}">{expression}</span>
{:else}
	<span data-edytor-equation-source>{expression}</span>
{/if}
