<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { MarqueeBoxPayload, MarqueeController } from './MarqueeController.svelte.js';

	/**
	 * The marquee's rectangle, in its overlay host (placed and sized to the
	 * rectangle by the plugin's measure): the app's `box`.
	 */
	let { controller, box }: { controller: MarqueeController; box: Snippet<[MarqueeBoxPayload]> } =
		$props();

	const payload = $derived(controller.payload);
</script>

{#if payload}{@render box(payload)}{/if}
