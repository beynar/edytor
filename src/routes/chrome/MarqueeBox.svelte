<script lang="ts">
	import type { MarqueeBoxPayload } from '$lib/index.js';

	/** Notion's rubber band, drawn for `createMarqueePlugin({ box })`: its host is placed and sized to it. */
	let { box }: { box: MarqueeBoxPayload } = $props();
</script>

<div class="marquee" data-edytor-marquee data-adding={box.adding ? 'true' : undefined}></div>

<style>
	.marquee {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		background: var(--edytor-marquee-background, rgba(35, 131, 226, 0.14));
		border: var(--edytor-marquee-border, 1px solid rgba(35, 131, 226, 0.4));
		border-radius: var(--edytor-marquee-radius, 2px);
	}
</style>
