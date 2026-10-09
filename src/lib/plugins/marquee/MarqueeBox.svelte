<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { MarqueeBoxPayload, MarqueeController } from './MarqueeController.svelte.js';

	/**
	 * The marquee's rectangle, in its overlay host (placed and sized to the
	 * rectangle by the plugin's measure): the default box, or the app's `box`.
	 */
	let { controller, box }: { controller: MarqueeController; box?: Snippet<[MarqueeBoxPayload]> } =
		$props();

	const payload = $derived(controller.payload);
</script>

{#if payload}
	{#if box}
		{@render box(payload)}
	{:else}
		<div data-edytor-marquee data-adding={payload.adding ? 'true' : undefined}></div>
	{/if}
{/if}

<style>
	[data-edytor-marquee] {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		background: var(--edytor-marquee-background, rgba(35, 131, 226, 0.14));
		border: var(--edytor-marquee-border, 1px solid rgba(35, 131, 226, 0.4));
		border-radius: var(--edytor-marquee-radius, 2px);
	}
</style>
